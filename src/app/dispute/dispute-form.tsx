"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";

type Status = "idle" | "submitting" | "done" | "error";

const fieldClass =
  "w-full bg-bg border border-border rounded-md px-3 py-2 text-sm text-fg " +
  "placeholder:text-fg-faint focus:outline-none focus:ring-1 focus:ring-accent";
const labelClass = "block text-sm font-medium text-fg mb-1";
const hintClass = "text-xs text-fg-faint mt-1";

export default function DisputeForm() {
  const params = useSearchParams();
  const prefill = params.get("slug") ?? params.get("person") ?? "";

  const [subject, setSubject] = useState(prefill);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [ticketId, setTicketId] = useState("");
  const [error, setError] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("submitting");
    setError("");
    try {
      const res = await fetch("/api/dispute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, name, email, message, evidenceUrl }),
      });
      const data = (await res.json()) as { ok: boolean; ticketId?: string; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Submission failed. Please try again.");
      }
      setTicketId(data.ticketId ?? "");
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed.");
      setStatus("error");
    }
  }

  if (status === "done") {
    return (
      <div className="border border-border rounded-md bg-surface p-6">
        <h2 className="font-serif text-xl font-semibold text-fg">Request received</h2>
        <p className="text-sm text-fg-muted mt-2">
          Thank you. Your correction/removal request has been logged with reference{" "}
          <span className="font-mono text-fg">{ticketId}</span>. We review each
          request against its source attribution and will correct or remove any
          figure we cannot support with a resolvable public source.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div>
        <label className={labelClass} htmlFor="subject">
          Which figure? <span className="text-fg-faint font-normal">(person slug or name)</span>
        </label>
        <input
          id="subject"
          className={fieldClass}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="e.g. elon-musk"
          required
        />
      </div>

      <div>
        <label className={labelClass} htmlFor="message">
          What is wrong?
        </label>
        <textarea
          id="message"
          className={`${fieldClass} min-h-32`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Describe the inaccuracy, the correct information, and any source that supports it."
          required
        />
        <p className={hintClass}>
          The more specific you are, the faster we can verify against the public
          record.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={labelClass} htmlFor="name">
            Your name <span className={hintClass}>(optional)</span>
          </label>
          <input
            id="name"
            className={fieldClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="email">
            Email <span className={hintClass}>(optional)</span>
          </label>
          <input
            id="email"
            type="email"
            className={fieldClass}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
      </div>

      <div>
        <label className={labelClass} htmlFor="evidenceUrl">
          Evidence URL <span className={hintClass}>(optional — a public source)</span>
        </label>
        <input
          id="evidenceUrl"
          type="url"
          className={fieldClass}
          value={evidenceUrl}
          onChange={(e) => setEvidenceUrl(e.target.value)}
          placeholder="https://…"
        />
      </div>

      {status === "error" && (
        <p className="text-sm text-danger">{error}</p>
      )}

      <button
        type="submit"
        disabled={status === "submitting"}
        className="bg-accent text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        {status === "submitting" ? "Submitting…" : "Submit request"}
      </button>
    </form>
  );
}
