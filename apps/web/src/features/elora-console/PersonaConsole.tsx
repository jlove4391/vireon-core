import { useState } from "react";
import { Link } from "react-router-dom";
import { Composer } from "../../components/Composer";
import { MessageBubble } from "../../components/MessageBubble";
import { ActionCard } from "../../components/ActionCard";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import type { PersonaConfig } from "@vireon/persona-config";
import { sendEloraMessage, EloraApiError, type EloraMessageResponse } from "../../lib/api";
import { getStoredThreadId, setStoredThreadId } from "../../lib/threadStorage";

interface ConversationEntry {
  id: string;
  role: "user" | "persona";
  content: string;
  timestamp: number;
  result?: EloraMessageResponse;
}

export interface PersonaConsoleProps {
  persona: PersonaConfig;
}

/**
 * Phase 6A §4: takes its identity as a prop, not a hardcoded import --
 * proven by the persona-config reusability check (handoff §12.8), which
 * renders this component against a throwaway PersonaConfig with no
 * changes to this file. Only ELORA_PERSONA is ever passed to it in the
 * real app (via EloraConsolePage) -- there is no persona selector.
 */
export function PersonaConsole({ persona }: PersonaConsoleProps) {
  const [threadId, setThreadId] = useState<string | undefined>(() => getStoredThreadId());
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (content: string) => {
    setError(null);
    const clientRequestId = crypto.randomUUID();
    const userEntry: ConversationEntry = {
      id: clientRequestId,
      role: "user",
      content,
      timestamp: Date.now(),
    };
    setEntries((prev) => [...prev, userEntry]);
    setIsSending(true);

    try {
      const result = await sendEloraMessage({ threadId, content, clientRequestId });
      setThreadId(result.threadId);
      setStoredThreadId(result.threadId);

      setEntries((prev) => {
        if (prev.some((entry) => entry.result?.messageId === result.messageId)) {
          return prev;
        }
        return [
          ...prev,
          {
            id: result.messageId,
            role: "persona",
            content: result.responseText,
            timestamp: Date.now(),
            result,
          },
        ];
      });
    } catch (err) {
      const message = err instanceof EloraApiError ? err.message : "Failed to reach the console backend.";
      setError(message);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col bg-shell-bg">
      <header className="flex items-center gap-3 border-b border-accent-cyan/20 px-6 py-4">
        <Link to="/" className="text-sm text-text-secondary hover:text-accent-cyan-glow">
          &larr; Home
        </Link>
        <img
          src={persona.crestAssetPath}
          alt=""
          aria-hidden="true"
          className="ml-4 h-10 w-10 rounded-full border border-accent-cyan/40"
        />
        <div>
          <h1 className="font-heading text-lg font-semibold text-text-primary">{persona.name}</h1>
          <p className="text-xs text-text-secondary">{persona.corporateRole}</p>
        </div>
      </header>

      <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-6 py-6">
        {entries.length === 0 && !isSending ? (
          <EmptyState
            title="No messages yet"
            description={`Send a message to start a conversation with ${persona.name}.`}
          />
        ) : (
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto">
            {entries.map((entry) => (
              <div key={entry.id} className="flex flex-col gap-2">
                <MessageBubble
                  role={entry.role}
                  personaName={persona.name}
                  content={entry.content}
                  timestamp={entry.timestamp}
                />
                {entry.result && <ActionCard result={entry.result} />}
              </div>
            ))}
            {/* Phase 6F §6: a live model call takes real seconds where
                everything before it has been near-instant -- a multi-second
                wait with no visual feedback would look like a frozen UI. */}
            {isSending && (
              <div className="flex flex-col items-start gap-1" aria-live="polite">
                <span className="text-xs uppercase tracking-wide text-text-secondary">{persona.name}</span>
                <div className="max-w-[75%] animate-pulse rounded-panel border border-accent-cyan/30 bg-accent-cyan/5 px-4 py-3 text-body text-text-secondary">
                  {persona.name} is thinking…
                </div>
              </div>
            )}
          </div>
        )}

        {error && <ErrorState message={error} />}

        <Composer onSubmit={handleSubmit} disabled={isSending} />
      </section>
    </main>
  );
}
