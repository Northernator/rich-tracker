import { NextResponse } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

// Node runtime — we write a JSON receipt to disk.
export const runtime = "nodejs";

interface DisputeBody {
  subject?: unknown;
  message?: unknown;
  name?: unknown;
  email?: unknown;
  evidenceUrl?: unknown;
}

function asString(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export async function POST(req: Request) {
  let body: DisputeBody;
  try {
    body = (await req.json()) as DisputeBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const subject = asString(body.subject, 200);
  const message = asString(body.message, 5000);
  if (!subject || !message) {
    return NextResponse.json(
      { ok: false, error: "A subject (the person or figure) and a description are required." },
      { status: 400 }
    );
  }

  const ticketId = `DSP-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const record = {
    ticketId,
    receivedAt: new Date().toISOString(),
    subject,
    name: asString(body.name, 200),
    email: asString(body.email, 200),
    message,
    evidenceUrl: asString(body.evidenceUrl, 500),
    status: "received",
  };

  const dir = join(process.cwd(), "data", "disputes");
  // data/ is gitignored; receipts are local intake, not source data.
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${ticketId}.json`), JSON.stringify(record, null, 2), "utf8");

  return NextResponse.json({ ok: true, ticketId });
}
