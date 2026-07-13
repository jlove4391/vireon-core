import { useState, type FormEvent } from "react";
import { Button } from "./Button";

interface ComposerProps {
  onSubmit: (content: string) => void;
  disabled: boolean;
}

export function Composer({ onSubmit, disabled }: ComposerProps) {
  const [value, setValue] = useState("");

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setValue("");
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-3">
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            handleSubmit(event);
          }
        }}
        disabled={disabled}
        placeholder="Send a message to Elora..."
        rows={2}
        className="flex-1 resize-none rounded-panel border border-accent-cyan/30 bg-shell-bg/80 p-3 text-body text-text-primary placeholder:text-text-secondary focus:border-accent-cyan focus:outline-none disabled:opacity-50"
      />
      <Button type="submit" disabled={disabled || !value.trim()}>
        {disabled ? "Sending..." : "Send"}
      </Button>
    </form>
  );
}
