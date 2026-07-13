interface MessageBubbleProps {
  role: "user" | "persona";
  personaName: string;
  content: string;
  timestamp: number;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function MessageBubble({ role, personaName, content, timestamp }: MessageBubbleProps) {
  const isUser = role === "user";

  return (
    <div className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
      <span className="text-xs uppercase tracking-wide text-text-secondary">
        {isUser ? "You" : personaName} · {formatTime(timestamp)}
      </span>
      <div
        className={`max-w-[75%] rounded-panel border px-4 py-3 text-body whitespace-pre-wrap ${
          isUser
            ? "border-accent-violet/40 bg-accent-violet/10 text-text-primary"
            : "border-accent-cyan/30 bg-accent-cyan/5 text-text-primary"
        }`}
      >
        {content}
      </div>
    </div>
  );
}
