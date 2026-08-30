import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-6">
      <div className="max-w-md text-center">
        <p className="text-xs uppercase tracking-widest text-fg-faint mb-3">
          404
        </p>
        <h1 className="font-serif text-4xl font-semibold text-fg mb-4">
          Page Not Found
        </h1>
        <p className="text-fg-muted leading-relaxed mb-8">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 px-4 py-2 border border-border text-sm font-medium text-fg rounded hover:bg-surface transition-colors"
        >
          ← Back to Rankings
        </Link>
      </div>
    </div>
  );
}
