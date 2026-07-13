import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: "primary" | "secondary";
}

export function Button({ children, variant = "primary", className = "", ...rest }: ButtonProps) {
  const base =
    "rounded-button px-5 py-3 font-body text-body font-medium transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50";
  const variants =
    variant === "primary"
      ? "bg-accent-cyan/10 text-accent-cyan-glow border border-accent-cyan hover:shadow-glow-cyan"
      : "bg-transparent text-text-primary border border-accent-violet/50 hover:border-accent-violet hover:shadow-glow-violet";

  return (
    <button className={`${base} ${variants} ${className}`} {...rest}>
      {children}
    </button>
  );
}
