import { formatDistanceToNow } from "date-fns";

const EVA_DECIMALS = 18n;

export function formatEVA(value: string | bigint, options: { compact?: boolean } = {}) {
  const big = typeof value === "bigint" ? value : BigInt(value);
  const divisor = 10n ** EVA_DECIMALS;
  const integerPart = big / divisor;
  const fractionalPart = big % divisor;
  const fractional = Number(fractionalPart) / Number(divisor);
  const formatted = Number(integerPart) + fractional;

  if (options.compact) {
    return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(formatted);
  }

  return Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(formatted);
}

export function formatMultiplier(multiplierHundredths: number) {
  return `${(multiplierHundredths / 100).toFixed(2)}x`;
}

export function formatPercentage(value: number, fractionDigits = 2) {
  return `${value.toFixed(fractionDigits)}%`;
}

export function formatDateTime(date: string) {
  return new Date(date).toLocaleString();
}

export function formatRelativeTime(date: string) {
  return formatDistanceToNow(new Date(date), { addSuffix: true });
}


