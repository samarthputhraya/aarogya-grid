import { NextResponse } from 'next/server';
import { overlaySnapshot } from '@/lib/overlay/store';

/**
 * Everything committed since the batch job ran.
 *
 * THIS ROUTE IS THE FIX FOR THE TRAP THAT LOOKS SOLVED
 * ----------------------------------------------------
 * `/console` statically imports the snapshot and `/district/[code]` is
 * `dynamicParams = false, revalidate = false`. Both are prerendered at BUILD
 * time, so a committed report can NEVER appear in freshly served HTML no matter
 * how correct the server-side recompute is.
 *
 * Server-Sent Events alone do not fix that, and this is the part that fools
 * people: a live delta arrives, the number changes on screen, the demo works --
 * and then a judge reloads the page and every committed change silently
 * disappears, because the reload serves the prerendered HTML again and the SSE
 * stream only carries what happens NEXT.
 *
 * So every console fetches this on mount AND subscribes to the stream. The mount
 * fetch supplies the past, the stream supplies the future. Forgetting either one
 * produces a demo that works until somebody presses F5.
 *
 * `seq` is the cursor: the client passes it to `/api/events` as `Last-Event-ID`
 * so the two sources cannot double-apply or skip an event between them.
 */

export const runtime = 'nodejs';
// The whole point is to be newer than the build. Caching this would reintroduce
// the exact staleness it exists to remove.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const snapshot = overlaySnapshot();
  return NextResponse.json(snapshot, {
    headers: { 'Cache-Control': 'no-store, must-revalidate' },
  });
}
