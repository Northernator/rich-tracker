import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import DisputeForm from "./dispute-form";

export const metadata: Metadata = {
  title: "Dispute this figure — Track the Rich",
  description:
    "Request a correction or removal of a published net-worth estimate or asset record.",
};

export default function DisputePage() {
  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <h1 className="font-serif text-3xl font-semibold tracking-tight text-fg mb-4">
        Dispute this figure
      </h1>
      <p className="text-fg-muted leading-relaxed mb-8">
        If a published estimate or asset record is inaccurate, out of date, or should
        not be published, tell us. Every request is reviewed against its source
        attribution; where a figure cannot be supported by a resolvable public
        source, it is corrected or removed. See the{" "}
        <Link href="/privacy" className="text-accent hover:underline">
          Privacy Policy
        </Link>{" "}
        for our lawful basis and your rights.
      </p>

      <Suspense fallback={<p className="text-sm text-fg-faint">Loading form…</p>}>
        <DisputeForm />
      </Suspense>
    </div>
  );
}
