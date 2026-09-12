import { DISTRICTS_BY_CODE } from '@/lib/domain/geo';
import { loadDistrictDetail, DistrictNotBuiltError } from '@/lib/district-cache';
import { ensureRestored } from '@/lib/durable/sink';
import { ticketsForDistrict } from '@/lib/dispatch/store';
import { toDispatchCsv } from '@/lib/dispatch/csv';

/**
 * The district's dispatch plan, as a stock-issue CSV a storekeeper can import.
 *
 * Served rather than assembled in the browser for two reasons. The ticket
 * states come from the server, so a client-side export would either be one
 * round trip behind or would need its own copy of the state machine; and a URL
 * can be checked with `curl` by somebody deciding whether this is a toy --
 * which is exactly the question a decision layer over DVDMS has to survive.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  await ensureRestored();

  const code = new URL(request.url).searchParams.get('districtCode');
  if (!code || !DISTRICTS_BY_CODE[code]) {
    return Response.json({ error: 'Unknown district: ' + (code ?? '(none)') }, { status: 404 });
  }

  let detail;
  try {
    detail = await loadDistrictDetail(code);
  } catch (e) {
    if (e instanceof DistrictNotBuiltError) {
      return Response.json(
        { error: 'No computed plan exists for ' + DISTRICTS_BY_CODE[code].name + '.' },
        { status: 404 },
      );
    }
    throw e;
  }

  const tickets = new Map(ticketsForDistrict(code).map((t) => [t.orderId, t]));
  const csv = toDispatchCsv(detail.orders, tickets, {
    districtCode: code,
    districtName: DISTRICTS_BY_CODE[code].name,
    indentDate: detail.builtAt.slice(0, 10),
  });

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition':
        'attachment; filename="aarogya-dispatch-' + code + '-' + detail.builtAt.slice(0, 10) + '.csv"',
      'Cache-Control': 'no-store',
    },
  });
}
