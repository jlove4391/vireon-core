interface ErrorStateProps {
  message: string;
}

export function ErrorState({ message }: ErrorStateProps) {
  return (
    <div className="rounded-panel border border-red-500/40 bg-red-950/20 p-4 text-sm text-red-300" role="alert">
      {message}
    </div>
  );
}
