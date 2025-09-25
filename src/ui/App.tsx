import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TrendApp } from "./TrendApp";
import { MakerApp } from "./MakerApp";
import { OffsetMakerApp } from "./OffsetMakerApp";

interface StrategyOption {
  id: "trend" | "maker" | "offset-maker";
  label: string;
  description: string;
  component: React.ComponentType<{ onExit: () => void }>;
}

const STRATEGIES: StrategyOption[] = [
  {
    id: "trend",
    label: "趋势跟随策略 (SMA30)",
    description: "监控均线信号，自动进出场并维护止损/止盈",
    component: TrendApp,
  },
  {
    id: "maker",
    label: "做市刷单策略",
    description: "双边挂单提供流动性，自动追价与风控止损",
    component: MakerApp,
  },
  {
    id: "offset-maker",
    label: "偏移做市策略",
    description: "根据盘口深度自动偏移挂单并在极端不平衡时撤退",
    component: OffsetMakerApp,
  },
];

const inputSupported = Boolean(process.stdin && (process.stdin as any).isTTY);

export function App() {
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<StrategyOption | null>(null);

  useInput(
    (input, key) => {
      if (selected) return;
      if (key.upArrow) {
        setCursor((prev) => (prev - 1 + STRATEGIES.length) % STRATEGIES.length);
      } else if (key.downArrow) {
        setCursor((prev) => (prev + 1) % STRATEGIES.length);
      } else if (key.return) {
        const strategy = STRATEGIES[cursor];
        if (strategy) {
          setSelected(strategy);
        }
      }
    },
    { isActive: inputSupported && !selected }
  );

  if (selected) {
    const Selected = selected.component;
    return <Selected onExit={() => setSelected(null)} />;
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text color="cyanBright">请选择要运行的策略</Text>
      <Text color="gray">使用 ↑/↓ 选择，回车开始，Ctrl+C 退出。</Text>
      <Box flexDirection="column" marginTop={1}>
        {STRATEGIES.map((strategy, index) => {
          const active = index === cursor;
          return (
            <Box key={strategy.id} flexDirection="column" marginBottom={1}>
              <Text color={active ? "greenBright" : undefined}>
                {active ? "➤" : "  "} {strategy.label}
              </Text>
              <Text color="gray">    {strategy.description}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
