interface EmptyStateProps {
  title: string;
  description: string;
}

export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-panel border border-dashed border-accent-violet/30 p-10 text-center">
      <p className="font-heading text-lg text-text-primary">{title}</p>
      <p className="max-w-md text-sm text-text-secondary">{description}</p>
    </div>
  );
}
