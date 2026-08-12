"use client";

// The business identity in the sidebar. Swaps with the selected business:
// logo image if one is committed, else the wordmark with its accented
// substring in the brand colour. Everything else in the interface keeps the
// shared design system — the brand swap is a letterhead change, not a
// redecoration.

import type { Business } from "@/lib/types";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function Wordmark({ business }: { business: Business | null }) {
  // Pre-auth and while loading, the product identity.
  if (!business) {
    return (
      <span className="text-[15px] font-bold tracking-tight">
        in<span className="text-brand-red">Style</span>
      </span>
    );
  }

  if (business.logo_path) {
    return (
      // Static export: plain img, logos live in public/brands/.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`${BASE_PATH}${business.logo_path}`}
        alt={business.name}
        className="h-5 max-w-36 object-contain object-left"
      />
    );
  }

  const wordmark = business.wordmark ?? business.name;
  const accent = business.wordmark_accent ?? "";
  const at = accent ? wordmark.indexOf(accent) : -1;

  return (
    <span className="flex items-baseline gap-2">
      <span className="text-[15px] font-bold tracking-tight">
        {at === -1 ? (
          wordmark
        ) : (
          <>
            {wordmark.slice(0, at)}
            <span style={{ color: business.brand_color }}>{accent}</span>
            {wordmark.slice(at + accent.length)}
          </>
        )}
      </span>
      {business.tagline && (
        <span className="text-[11px] text-text-muted">{business.tagline}</span>
      )}
    </span>
  );
}
