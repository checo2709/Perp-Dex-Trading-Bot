import type { TradingConfig } from "../config";
import type { ExchangeAdapter } from "../exchanges/adapter";
import type {
  AsterAccountSnapshot,
  AsterOrder,
  AsterTicker,
  AsterDepth,
  AsterKline,
} from "../exchanges/types";
import {
  calcStopLossPrice,
  calcTrailingActivationPrice,
  getPosition,
  getSMA,
  type PositionSnapshot,
} from "../utils/strategy";
import { computePositionPnl } from "../utils/pnl";
import { getMidOrLast } from "../utils/price";
import {
  marketClose,
  placeMarketOrder,
  placeStopLossOrder,
  placeTrailingStopOrder,
  unlockOperating,
} from "./order-coordinator";
import type { OrderLockMap, OrderPendingMap, OrderTimerMap } from "./order-coordinator";
import { isUnknownOrderError } from "../utils/errors";
import { roundDownToTick } from "../utils/math";
import { createTradeLog, type TradeLogEntry } from "../state/trade-log";

export interface TrendEngineSnapshot {
  ready: boolean;
  symbol: string;
  lastPrice: number | null;
  sma30: number | null;
  trend: "做多" | "做空" | "无信号";
  position: PositionSnapshot;
  pnl: number;
  unrealized: number;
  totalProfit: number;
  totalTrades: number;
  sessionVolume: number;
  tradeLog: TradeLogEntry[];
  openOrders: AsterOrder[];
  depth: AsterDepth | null;
  ticker: AsterTicker | null;
  lastUpdated: number | null;
  lastOpenSignal: OpenOrderPlan;
}

export interface OpenOrderPlan {
  side: "BUY" | "SELL" | null;
  price: number | null;
}

type TrendEngineEvent = "update";

type TrendEngineListener = (snapshot: TrendEngineSnapshot) => void;

export class TrendEngine {
  private accountSnapshot: AsterAccountSnapshot | null = null;
  private openOrders: AsterOrder[] = [];
  private depthSnapshot: AsterDepth | null = null;
  private tickerSnapshot: AsterTicker | null = null;
  private klineSnapshot: AsterKline[] = [];

  private readonly locks: OrderLockMap = {};
  private readonly timers: OrderTimerMap = {};
  private readonly pending: OrderPendingMap = {};

  private readonly tradeLog: ReturnType<typeof createTradeLog>;

  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private lastPrice: number | null = null;
  private lastSma30: number | null = null;
  private totalProfit = 0;
  private totalTrades = 0;
  private lastOpenPlan: OpenOrderPlan = { side: null, price: null };
  private sessionQuoteVolume = 0;
  private prevPositionAmt = 0;
  private initializedPosition = false;
  private cancelAllRequested = false;
  private readonly pendingCancelOrders = new Set<number>();

  // 控制入场频率：同一分钟内最多入场一次
  private lastEntryMinute: number | null = null;
  // 止损后冷却：止损发生后的 60s 内忽略 SMA 入场信号
  private lastStopLossAt: number | null = null;

  private ordersSnapshotReady = false;
  private startupLogged = false;
  private entryPricePendingLogged = false;

  private readonly listeners = new Map<TrendEngineEvent, Set<TrendEngineListener>>();

  constructor(private readonly config: TradingConfig, private readonly exchange: ExchangeAdapter) {
    this.tradeLog = createTradeLog(this.config.maxLogEntries);
    this.bootstrap();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  on(event: TrendEngineEvent, handler: TrendEngineListener): void {
    const handlers = this.listeners.get(event) ?? new Set<TrendEngineListener>();
    handlers.add(handler);
    this.listeners.set(event, handlers);
  }

  off(event: TrendEngineEvent, handler: TrendEngineListener): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) {
      this.listeners.delete(event);
    }
  }

  getSnapshot(): TrendEngineSnapshot {
    return this.buildSnapshot();
  }

  private bootstrap(): void {
    try {
      this.exchange.watchAccount((snapshot) => {
        try {
          this.accountSnapshot = snapshot;
          const position = getPosition(snapshot, this.config.symbol);
          this.updateSessionVolume(position);
          this.emitUpdate();
        } catch (err) {
          this.tradeLog.push("error", `账户推送处理异常: ${String(err)}`);
        }
      });
    } catch (err) {
      this.tradeLog.push("error", `订阅账户失败: ${String(err)}`);
    }
    try {
      this.exchange.watchOrders((orders) => {
        try {
          this.synchronizeLocks(orders);
          this.openOrders = Array.isArray(orders)
            ? orders.filter((order) => order.type !== "MARKET" && order.symbol === this.config.symbol)
            : [];
          const currentIds = new Set(this.openOrders.map((order) => order.orderId));
          for (const id of Array.from(this.pendingCancelOrders)) {
            if (!currentIds.has(id)) {
              this.pendingCancelOrders.delete(id);
            }
          }
          if (this.openOrders.length === 0 || this.pendingCancelOrders.size === 0) {
            this.cancelAllRequested = false;
          }
          this.ordersSnapshotReady = true;
          this.emitUpdate();
        } catch (err) {
          this.tradeLog.push("error", `订单推送处理异常: ${String(err)}`);
        }
      });
    } catch (err) {
      this.tradeLog.push("error", `订阅订单失败: ${String(err)}`);
    }
    try {
      this.exchange.watchDepth(this.config.symbol, (depth) => {
        try {
          this.depthSnapshot = depth;
          this.emitUpdate();
        } catch (err) {
          this.tradeLog.push("error", `深度推送处理异常: ${String(err)}`);
        }
      });
    } catch (err) {
      this.tradeLog.push("error", `订阅深度失败: ${String(err)}`);
    }
    try {
      this.exchange.watchTicker(this.config.symbol, (ticker) => {
        try {
          this.tickerSnapshot = ticker;
          this.emitUpdate();
        } catch (err) {
          this.tradeLog.push("error", `价格推送处理异常: ${String(err)}`);
        }
      });
    } catch (err) {
      this.tradeLog.push("error", `订阅Ticker失败: ${String(err)}`);
    }
    try {
      this.exchange.watchKlines(this.config.symbol, this.config.klineInterval, (klines) => {
        try {
          this.klineSnapshot = Array.isArray(klines) ? klines : [];
          this.emitUpdate();
        } catch (err) {
          this.tradeLog.push("error", `K线推送处理异常: ${String(err)}`);
        }
      });
    } catch (err) {
      this.tradeLog.push("error", `订阅K线失败: ${String(err)}`);
    }
  }

  private synchronizeLocks(orders: AsterOrder[] | null | undefined): void {
    const list = Array.isArray(orders) ? orders : [];
    Object.keys(this.pending).forEach((type) => {
      const pendingId = this.pending[type];
      if (!pendingId) return;
      const match = list.find((order) => String(order.orderId) === pendingId);
      if (!match || (match.status && match.status !== "NEW")) {
        unlockOperating(this.locks, this.timers, this.pending, type);
      }
    });
  }

  private isReady(): boolean {
    return Boolean(
      this.accountSnapshot &&
        this.tickerSnapshot &&
        this.depthSnapshot &&
        this.klineSnapshot.length >= 30
    );
  }

  private async tick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      if (!this.ordersSnapshotReady) {
        this.emitUpdate();
        return;
      }
      if (!this.isReady()) {
        this.emitUpdate();
        return;
      }
      this.logStartupState();
      const sma30 = getSMA(this.klineSnapshot, 30);
      if (sma30 == null) {
        return;
      }
      const ticker = this.tickerSnapshot!;
      const price = Number(ticker.lastPrice);
      const position = getPosition(this.accountSnapshot, this.config.symbol);

      if (Math.abs(position.positionAmt) < 1e-5) {
        await this.handleOpenPosition(price, sma30);
      } else {
        const result = await this.handlePositionManagement(position, price);
        if (result.closed) {
          this.totalTrades += 1;
          this.totalProfit += result.pnl;
        }
      }

      this.updateSessionVolume(position);
      this.lastSma30 = sma30;
      this.lastPrice = price;
      this.emitUpdate();
    } catch (error) {
      this.tradeLog.push("error", `策略循环异常: ${String(error)}`);
      this.emitUpdate();
    } finally {
      this.processing = false;
    }
  }

  private logStartupState(): void {
    if (this.startupLogged) return;
    const position = getPosition(this.accountSnapshot, this.config.symbol);
    const hasPosition = Math.abs(position.positionAmt) > 1e-5;
    if (hasPosition) {
      this.tradeLog.push(
        "info",
        `检测到已有持仓: ${position.positionAmt > 0 ? "多" : "空"} ${Math.abs(position.positionAmt).toFixed(4)} @ ${position.entryPrice.toFixed(2)}`
      );
    }
    if (this.openOrders.length > 0) {
      this.tradeLog.push("info", `检测到已有挂单 ${this.openOrders.length} 笔，将按策略规则接管`);
    }
    this.startupLogged = true;
  }

  private async handleOpenPosition(currentPrice: number, currentSma: number): Promise<void> {
    this.entryPricePendingLogged = false;
    const now = Date.now();
    const currentMinute = Math.floor(now / 60_000);
    // 止损后的冷却期：60s 内不允许基于 SMA 穿越再次入场
    if (this.lastStopLossAt != null && now - this.lastStopLossAt < 60_000) {
      const remaining = Math.max(0, 60_000 - (now - this.lastStopLossAt));
      this.tradeLog.push("info", `止损后冷却中 ${(remaining / 1000).toFixed(0)}s，忽略入场信号`);
      return;
    }
    // 同一分钟只允许一次入场
    if (this.lastEntryMinute != null && this.lastEntryMinute === currentMinute) {
      this.tradeLog.push("info", "本分钟已入场，忽略新的 SMA 入场信号");
      return;
    }
    if (this.lastPrice == null) {
      this.lastPrice = currentPrice;
      return;
    }
    if (this.openOrders.length > 0 && !this.cancelAllRequested) {
      try {
        await this.exchange.cancelAllOrders({ symbol: this.config.symbol });
        this.cancelAllRequested = true;
        // 清空本地挂单与撤单队列，避免在下一轮中基于过期快照继续操作
        this.pendingCancelOrders.clear();
        this.openOrders = [];
      } catch (err) {
        if (isUnknownOrderError(err)) {
          this.tradeLog.push("order", "撤单时部分订单已不存在，忽略");
          this.cancelAllRequested = true;
          // 与成功撤单路径保持一致，立即清空本地缓存，等待订单流推送重建
          this.pendingCancelOrders.clear();
          this.openOrders = [];
        } else {
          this.tradeLog.push("error", `撤销挂单失败: ${String(err)}`);
          this.cancelAllRequested = false;
        }
      }
    }
    if (this.lastPrice > currentSma && currentPrice < currentSma) {
      await this.submitMarketOrder("SELL", currentPrice, "下穿SMA30，市价开空");
      this.lastEntryMinute = currentMinute;
    } else if (this.lastPrice < currentSma && currentPrice > currentSma) {
      await this.submitMarketOrder("BUY", currentPrice, "上穿SMA30，市价开多");
      this.lastEntryMinute = currentMinute;
    }
  }

  private async submitMarketOrder(side: "BUY" | "SELL", price: number, reason: string): Promise<void> {
    try {
      await placeMarketOrder(
        this.exchange,
        this.config.symbol,
        this.openOrders,
        this.locks,
        this.timers,
        this.pending,
        side,
        this.config.tradeAmount,
        (type, detail) => this.tradeLog.push(type, detail),
        false,
        {
          markPrice: getPosition(this.accountSnapshot, this.config.symbol).markPrice,
          expectedPrice: Number(this.tickerSnapshot?.lastPrice) || null,
          maxPct: this.config.maxCloseSlippagePct,
        },
        { qtyStep: this.config.qtyStep }
      );
      this.tradeLog.push("open", `${reason}: ${side} @ ${price}`);
      this.lastOpenPlan = { side, price };
    } catch (err) {
      this.tradeLog.push("error", `市价下单失败: ${String(err)}`);
    }
  }

  private async handlePositionManagement(
    position: PositionSnapshot,
    price: number
  ): Promise<{ closed: boolean; pnl: number }> {
    const hasEntryPrice = Number.isFinite(position.entryPrice) && Math.abs(position.entryPrice) > 1e-8;
    if (!hasEntryPrice) {
      if (!this.entryPricePendingLogged) {
        this.tradeLog.push("info", "持仓均价尚未同步，等待交易所账户快照更新后再执行风控");
        this.entryPricePendingLogged = true;
      }
      return { closed: false, pnl: position.unrealizedProfit };
    }
    this.entryPricePendingLogged = false;
    const direction = position.positionAmt > 0 ? "long" : "short";
    const pnl =
      (direction === "long"
        ? price - position.entryPrice
        : position.entryPrice - price) * Math.abs(position.positionAmt);
    const unrealized = Number.isFinite(position.unrealizedProfit)
      ? position.unrealizedProfit
      : null;
    const stopSide = direction === "long" ? "SELL" : "BUY";
    const stopPrice = calcStopLossPrice(
      position.entryPrice,
      Math.abs(position.positionAmt),
      direction,
      this.config.lossLimit
    );
    const activationPrice = calcTrailingActivationPrice(
      position.entryPrice,
      Math.abs(position.positionAmt),
      direction,
      this.config.trailingProfit
    );

    const currentStop = this.openOrders.find(
      (o) => o.type === "STOP_MARKET" && o.side === stopSide
    );
    const currentTrailing = this.openOrders.find(
      (o) => o.type === "TRAILING_STOP_MARKET" && o.side === stopSide
    );

    // 步进式锁盈移动：在动态止盈生效前，盈利每增加一个 profitLockOffsetUsd 就上移/下移一次止损
    {
      const tick = Math.max(1e-9, this.config.priceTick);
      const qtyAbs = Math.abs(position.positionAmt);
      const stepUsd = Math.max(0, this.config.profitLockOffsetUsd);
      const triggerUsd = Math.max(0, this.config.profitLockTriggerUsd);
      const trailingActivateFromOrderRaw = currentTrailing?.activatePrice ?? (currentTrailing as any)?.activationPrice;
      const trailingActivateFromOrder = Number(trailingActivateFromOrderRaw);
      const trailingActivate = Number.isFinite(trailingActivateFromOrder)
        ? trailingActivateFromOrder
        : activationPrice;

      // 判断动态止盈是否已生效：多头 price >= activate；空头 price <= activate
      const trailingActivated =
        direction === "long"
          ? Number.isFinite(trailingActivate) && price >= trailingActivate - tick
          : Number.isFinite(trailingActivate) && price <= trailingActivate + tick;

      // 仅在动态止盈未生效时执行步进移动
      if (!trailingActivated && qtyAbs > 0 && stepUsd > 0) {
        const basisProfit = Number.isFinite(unrealized ?? pnl) ? Math.max(pnl, unrealized ?? pnl) : pnl;
        if (basisProfit >= triggerUsd) {
          const over = basisProfit - triggerUsd;
          const steps = 1 + Math.floor(over / stepUsd);
          const stepPx = stepUsd / qtyAbs;
          const rawTarget = direction === "long"
            ? position.entryPrice + steps * stepPx
            : position.entryPrice - steps * stepPx;
          let targetStop = roundDownToTick(rawTarget, this.config.priceTick);

          // 不允许下一次移动超过动态止盈订单的激活价
          if (Number.isFinite(trailingActivate)) {
            if (stopSide === "SELL" && targetStop >= trailingActivate - tick) {
              // 达到或超过激活价，停止移动
              targetStop = Math.min(targetStop, trailingActivate - tick);
              // 若已经无法进一步改善，则不再尝试
              const existingRaw = Number(currentStop?.stopPrice);
              const existingPrice = Number.isFinite(existingRaw) ? existingRaw : NaN;
              const canImprove =
                !Number.isFinite(existingPrice) ||
                (stopSide === "SELL" && targetStop >= existingPrice + tick);
              if (!canImprove) {
                // 直接跳过
                // no-op
              } else if (currentStop) {
                await this.tryReplaceStop(stopSide, currentStop, targetStop, price);
              } else {
                await this.tryPlaceStopLoss(stopSide, targetStop, price);
              }
            } else if (stopSide === "BUY" && targetStop <= trailingActivate + tick) {
              targetStop = Math.max(targetStop, trailingActivate + tick);
              const existingRaw = Number(currentStop?.stopPrice);
              const existingPrice = Number.isFinite(existingRaw) ? existingRaw : NaN;
              const canImprove =
                !Number.isFinite(existingPrice) ||
                (stopSide === "BUY" && targetStop <= existingPrice - tick);
              if (!canImprove) {
                // no-op
              } else if (currentStop) {
                await this.tryReplaceStop(stopSide, currentStop, targetStop, price);
              } else {
                await this.tryPlaceStopLoss(stopSide, targetStop, price);
              }
            } else {
              // 正常范围内，且必须与当前价方向不冲突
              const validForSide =
                (stopSide === "SELL" && targetStop <= price - tick) ||
                (stopSide === "BUY" && targetStop >= price + tick);
              if (validForSide) {
                if (!currentStop) {
                  await this.tryPlaceStopLoss(stopSide, targetStop, price);
                } else {
                  const existingRaw = Number(currentStop.stopPrice);
                  const existingPrice = Number.isFinite(existingRaw) ? existingRaw : NaN;
                  const improves =
                    !Number.isFinite(existingPrice) ||
                    (stopSide === "SELL" && targetStop >= existingPrice + tick) ||
                    (stopSide === "BUY" && targetStop <= existingPrice - tick);
                  if (improves) {
                    await this.tryReplaceStop(stopSide, currentStop, targetStop, price);
                  }
                }
              }
            }
          } else {
            // 无法取得动态止盈激活价时，仅按普通步进逻辑
            const validForSide =
              (stopSide === "SELL" && targetStop <= price - tick) ||
              (stopSide === "BUY" && targetStop >= price + tick);
            if (validForSide) {
              if (!currentStop) {
                await this.tryPlaceStopLoss(stopSide, targetStop, price);
              } else {
                const existingRaw = Number(currentStop.stopPrice);
                const existingPrice = Number.isFinite(existingRaw) ? existingRaw : NaN;
                const improves =
                  !Number.isFinite(existingPrice) ||
                  (stopSide === "SELL" && targetStop >= existingPrice + tick) ||
                  (stopSide === "BUY" && targetStop <= existingPrice - tick);
                if (improves) {
                  await this.tryReplaceStop(stopSide, currentStop, targetStop, price);
                }
              }
            }
          }
        }
      }
    }

    if (!currentStop) {
      await this.tryPlaceStopLoss(stopSide, roundDownToTick(stopPrice, this.config.priceTick), price);
    }

    if (!currentTrailing) {
      await this.tryPlaceTrailingStop(
        stopSide,
        roundDownToTick(activationPrice, this.config.priceTick),
        Math.abs(position.positionAmt)
      );
    }

    const derivedLoss = pnl < -this.config.lossLimit;
    const snapshotLoss = Boolean(
      unrealized != null &&
        unrealized < -this.config.lossLimit &&
        pnl <= 0
    );

    if (derivedLoss || snapshotLoss) {
      try {
        if (this.openOrders.length > 0) {
          const orderIdList = this.openOrders.map((order) => order.orderId);
          try {
            await this.exchange.cancelOrders({ symbol: this.config.symbol, orderIdList });
            orderIdList.forEach((id) => this.pendingCancelOrders.add(id));
          } catch (err) {
            if (isUnknownOrderError(err)) {
              this.tradeLog.push("order", "止损前撤单发现订单已不存在");
                // 清理本地缓存，避免重复对同一订单执行撤单
                for (const id of orderIdList) {
                  this.pendingCancelOrders.delete(id);
                }
                this.openOrders = this.openOrders.filter((o) => !orderIdList.includes(o.orderId));
            } else {
              throw err;
            }
          }
        }
        // 价格操纵保护：仅当平仓方向价格与标记价格偏离在阈值内才执行市价平仓
        const mark = getPosition(this.accountSnapshot, this.config.symbol).markPrice;
        const limitPct = this.config.maxCloseSlippagePct;
        const sideIsSell = direction === "long";
        const depthBid = Number(this.depthSnapshot?.bids?.[0]?.[0]);
        const depthAsk = Number(this.depthSnapshot?.asks?.[0]?.[0]);
        const closeSidePrice = sideIsSell ? depthBid : depthAsk;
        if (mark != null && Number.isFinite(mark) && mark > 0 && Number.isFinite(closeSidePrice)) {
          const pctDiff = Math.abs(closeSidePrice - mark) / mark;
          if (pctDiff > limitPct) {
            this.tradeLog.push(
              "info",
              `市价平仓保护触发：closePx=${Number(closeSidePrice).toFixed(2)} mark=${mark.toFixed(2)} 偏离 ${(pctDiff * 100).toFixed(2)}% > ${(limitPct * 100).toFixed(2)}%`
            );
            return { closed: false, pnl };
          }
        }
        await marketClose(
          this.exchange,
          this.config.symbol,
          this.openOrders,
          this.locks,
          this.timers,
          this.pending,
          direction === "long" ? "SELL" : "BUY",
          Math.abs(position.positionAmt),
          (type, detail) => this.tradeLog.push(type, detail),
          {
            markPrice: getPosition(this.accountSnapshot, this.config.symbol).markPrice,
            expectedPrice: Number(
              direction === "long"
                ? this.depthSnapshot?.bids?.[0]?.[0]
                : this.depthSnapshot?.asks?.[0]?.[0]
            ) || null,
            maxPct: this.config.maxCloseSlippagePct,
        },
        { qtyStep: this.config.qtyStep }
        );
        this.tradeLog.push("close", `止损平仓: ${direction === "long" ? "SELL" : "BUY"}`);
        // 记录止损时间以便短期内抑制再次入场
        this.lastStopLossAt = Date.now();
      } catch (err) {
        if (isUnknownOrderError(err)) {
          this.tradeLog.push("order", "止损平仓时目标订单已不存在");
        } else {
          this.tradeLog.push("error", `止损平仓失败: ${String(err)}`);
        }
      }
      return { closed: true, pnl };
    }

    return { closed: false, pnl };
  }

  private async tryPlaceStopLoss(
    side: "BUY" | "SELL",
    stopPrice: number,
    lastPrice: number
  ): Promise<void> {
    try {
      const position = getPosition(this.accountSnapshot, this.config.symbol);
      const quantity = Math.abs(position.positionAmt) || this.config.tradeAmount;
      await placeStopLossOrder(
        this.exchange,
        this.config.symbol,
        this.openOrders,
        this.locks,
        this.timers,
        this.pending,
        side,
        stopPrice,
        quantity,
        lastPrice,
        (type, detail) => this.tradeLog.push(type, detail),
        {
          markPrice: position.markPrice,
          maxPct: this.config.maxCloseSlippagePct,
        },
        { priceTick: this.config.priceTick, qtyStep: this.config.qtyStep }
      );
    } catch (err) {
      this.tradeLog.push("error", `挂止损单失败: ${String(err)}`);
    }
  }

  private async tryReplaceStop(
    side: "BUY" | "SELL",
    currentOrder: AsterOrder,
    nextStopPrice: number,
    lastPrice: number
  ): Promise<void> {
    // 预校验：SELL 止损价必须低于当前价；BUY 止损价必须高于当前价
    const invalidForSide =
      (side === "SELL" && nextStopPrice >= lastPrice) ||
      (side === "BUY" && nextStopPrice <= lastPrice);
    if (invalidForSide) {
      // 目标止损价与当前价冲突时跳过移动，避免反复撤单/重下导致的循环
      return;
    }
    const existingStopPrice = Number(currentOrder.stopPrice);
    try {
      await this.exchange.cancelOrder({ symbol: this.config.symbol, orderId: currentOrder.orderId });
    } catch (err) {
      if (isUnknownOrderError(err)) {
        this.tradeLog.push("order", "原止损单已不存在，跳过撤销");
        // 订单已不存在，移除本地记录，防止后续重复匹配
        this.openOrders = this.openOrders.filter((o) => o.orderId !== currentOrder.orderId);
      } else {
        this.tradeLog.push("error", `取消原止损单失败: ${String(err)}`);
      }
    }
    // 仅在成功创建新止损单后记录“移动止损”日志
    try {
      const position = getPosition(this.accountSnapshot, this.config.symbol);
      const quantity = Math.abs(position.positionAmt) || this.config.tradeAmount;
      const order = await placeStopLossOrder(
        this.exchange,
        this.config.symbol,
        this.openOrders,
        this.locks,
        this.timers,
        this.pending,
        side,
        nextStopPrice,
        quantity,
        lastPrice,
        (type, detail) => this.tradeLog.push(type, detail),
        {
          markPrice: position.markPrice,
          maxPct: this.config.maxCloseSlippagePct,
        },
        { priceTick: this.config.priceTick, qtyStep: this.config.qtyStep }
      );
      if (order) {
        this.tradeLog.push("stop", `移动止损到 ${roundDownToTick(nextStopPrice, this.config.priceTick)}`);
      }
    } catch (err) {
      this.tradeLog.push("error", `移动止损失败: ${String(err)}`);
      // 回滚策略：尝试用原价恢复止损，以避免出现短时间内无止损保护
      try {
        const position = getPosition(this.accountSnapshot, this.config.symbol);
        const quantity = Math.abs(position.positionAmt) || this.config.tradeAmount;
        const restoreInvalid =
          (side === "SELL" && existingStopPrice >= lastPrice) ||
          (side === "BUY" && existingStopPrice <= lastPrice);
        if (!restoreInvalid) {
          const restored = await placeStopLossOrder(
            this.exchange,
            this.config.symbol,
            this.openOrders,
            this.locks,
            this.timers,
            this.pending,
            side,
            existingStopPrice,
            quantity,
            lastPrice,
            (t, d) => this.tradeLog.push(t, d),
            {
              markPrice: position.markPrice,
              maxPct: this.config.maxCloseSlippagePct,
            },
            { priceTick: this.config.priceTick, qtyStep: this.config.qtyStep }
          );
          if (restored) {
            this.tradeLog.push("order", `恢复原止损 @ ${roundDownToTick(existingStopPrice, this.config.priceTick)}`);
          }
        }
      } catch (recoverErr) {
        this.tradeLog.push("error", `恢复原止损失败: ${String(recoverErr)}`);
      }
    }
  }

  private async tryPlaceTrailingStop(
    side: "BUY" | "SELL",
    activationPrice: number,
    quantity: number
  ): Promise<void> {
    try {
      await placeTrailingStopOrder(
        this.exchange,
        this.config.symbol,
        this.openOrders,
        this.locks,
        this.timers,
        this.pending,
        side,
        activationPrice,
        quantity,
        this.config.trailingCallbackRate,
        (type, detail) => this.tradeLog.push(type, detail),
        {
          markPrice: getPosition(this.accountSnapshot, this.config.symbol).markPrice,
          maxPct: this.config.maxCloseSlippagePct,
        },
        { priceTick: this.config.priceTick, qtyStep: this.config.qtyStep }
      );
    } catch (err) {
      this.tradeLog.push("error", `挂动态止盈失败: ${String(err)}`);
    }
  }

  private emitUpdate(): void {
    try {
      const snapshot = this.buildSnapshot();
      const handlers = this.listeners.get("update");
      if (handlers) {
        handlers.forEach((handler) => {
          try {
            handler(snapshot);
          } catch (err) {
            this.tradeLog.push("error", `更新回调处理异常: ${String(err)}`);
          }
        });
      }
    } catch (err) {
      this.tradeLog.push("error", `快照或更新分发异常: ${String(err)}`);
    }
  }

  private buildSnapshot(): TrendEngineSnapshot {
    const position = getPosition(this.accountSnapshot, this.config.symbol);
    const price = this.tickerSnapshot ? Number(this.tickerSnapshot.lastPrice) : null;
    const sma30 = this.lastSma30;
    const trend = price == null || sma30 == null
      ? "无信号"
      : price > sma30
      ? "做多"
      : price < sma30
      ? "做空"
      : "无信号";
    const pnl = price != null ? computePositionPnl(position, price, price) : 0;
    return {
      ready: this.isReady(),
      symbol: this.config.symbol,
      lastPrice: price,
      sma30,
      trend,
      position,
      pnl,
      unrealized: position.unrealizedProfit,
      totalProfit: this.totalProfit,
      totalTrades: this.totalTrades,
      sessionVolume: this.sessionQuoteVolume,
      tradeLog: this.tradeLog.all(),
      openOrders: this.openOrders,
      depth: this.depthSnapshot,
      ticker: this.tickerSnapshot,
      lastUpdated: Date.now(),
      lastOpenSignal: this.lastOpenPlan,
    };
  }

  private updateSessionVolume(position: PositionSnapshot): void {
    const price = this.getReferencePrice();
    if (!this.initializedPosition) {
      this.prevPositionAmt = position.positionAmt;
      this.initializedPosition = true;
      return;
    }
    if (price == null) {
      this.prevPositionAmt = position.positionAmt;
      return;
    }
    const delta = Math.abs(position.positionAmt - this.prevPositionAmt);
    if (delta > 0) {
      this.sessionQuoteVolume += delta * price;
    }
    this.prevPositionAmt = position.positionAmt;
  }

  private getReferencePrice(): number | null {
    return getMidOrLast(this.depthSnapshot, this.tickerSnapshot) ?? (this.lastPrice != null && Number.isFinite(this.lastPrice) ? this.lastPrice : null);
  }

}
