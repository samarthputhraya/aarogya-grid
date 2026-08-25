import Link from 'next/link';
import { DISTRICTS } from '@/lib/domain/geo';

/**
 * Unknown district code.
 *
 * Reached only by a hand-typed or stale URL: `dynamicParams = false` means the
 * router 404s anything outside `generateStaticParams`. The count is printed
 * because "no such district" and "this district is not in the modelled set"
 * are different statements, and only the second one is true here.
 */
export default function NotFound() {
  return (
    <div className="min-h-screen grid place-items-center p-8">
      <div className="panel max-w-md p-5">
        <div className="text-sm text-mist-100 mb-2">No such district</div>
        <p className="text-xs text-mist-400 mb-4 leading-relaxed">
          That code is not one of the{' '}
          <span className="tnum text-mist-200">{DISTRICTS.length}</span> districts in the modelled
          network. District codes look like{' '}
          <span className="tnum text-mist-300">DST-22-BASTAR</span> — the state LGD code, then the
          district name. Pick one from the national map instead.
        </p>
        <Link
          href="/console"
          className="inline-block text-[11px] px-3 py-1.5 rounded border border-brand/40 text-brand hover:bg-brand/10 transition-colors"
        >
          ← National view
        </Link>
      </div>
    </div>
  );
}
