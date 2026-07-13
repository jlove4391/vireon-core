// Phase 6A §3/§12.4: single implicit dev thread. First message creates it,
// everything after continues it. localStorage is explicitly fine for this
// dev-only scope -- refresh must not lose the ability to continue the
// thread.

const STORAGE_KEY = "vireon.elora.threadId";

export function getStoredThreadId(): string | undefined {
  return localStorage.getItem(STORAGE_KEY) ?? undefined;
}

export function setStoredThreadId(threadId: string): void {
  localStorage.setItem(STORAGE_KEY, threadId);
}
