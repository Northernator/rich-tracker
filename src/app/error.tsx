"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-6">
      <div className="max-w-md text-center">
        <p className="text-xs uppercase tracking-widest text-fg-faint mb-3">
          Something went wrong
        </p>
        <h1 className="font-serif text-4xl font-semibold text-fg mb-4">
          Server Error
        </h1>
        <p className="text-fg-muted leading-relaxed mb-8">
          We encountered an error rendering this page. The data layer may be
          unavailable or the request may have timed out.
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={reset}
            className="px-4 py-2 bg-accent text-white text-sm font-medium rounded hover:bg-accent/90 transition-colors"
          >
            Try again
          </button>
          <Link
            href="/"
            className="px-4 py-2 border border-border text-sm font-medium text-fg rounded hover:bg-surface transition-colors"
          >
            Go home
          </Link>
        </div>
        {process.env.NODE_ENV === "development" && error.digest && (
          <p className="mt-8 text-xs text-fg-faint font-mono">
            Digest: {error.digest}
          </p>
        )}
      </div>
    </div>
  );
}
