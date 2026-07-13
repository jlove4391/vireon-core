import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  glow?: "cyan" | "violet" | "none";
}

export function Card({ children, className = "", glow = "none" }: CardProps) {
  const glowClass = glow === "cyan" ? "shadow-glow-cyan" : glow === "violet" ? "shadow-glow-violet" : "";

  return (
    <div
      className={`rounded-panel border border-accent-cyan/20 bg-shell-bg/60 p-6 backdrop-blur-sm ${glowClass} ${className}`}
    >
      {children}
    </div>
  );
}
