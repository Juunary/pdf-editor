import { useEffect, useRef } from 'preact/hooks';
import { cssBoxStyle, quadToCssBox, type PageLayout } from '../layout.js';
import type { PageHit } from '../search-nav.js';

interface Props {
  hits: PageHit[];
  layout: PageLayout;
  pageIndex: number;
}

/** Search result quad highlights. The current result has a different color and is scrolled to the screen center. */
export function HighlightLayer({ hits, layout, pageIndex }: Props) {
  const currentRef = useRef<HTMLDivElement>(null);
  const current = hits.find((h) => h.current);
  const scrollKey = current ? `${pageIndex}:${current.index}` : '';

  useEffect(() => {
    if (scrollKey) currentRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [scrollKey]);

  return (
    <div id="pe-highlights" class="pe-hl-layer" aria-hidden="true">
      {hits.flatMap(({ index, hit, current: isCurrent }) =>
        hit.quads.map((quad, qi) => (
          <div
            key={`${index}-${qi}`}
            ref={isCurrent && qi === 0 ? currentRef : undefined}
            class={isCurrent ? 'pe-hl pe-hl-current' : 'pe-hl'}
            data-hit={index}
            data-current={isCurrent ? 'true' : 'false'}
            data-quad={quad.join(',')}
            style={cssBoxStyle(quadToCssBox(quad, layout.cssScale, layout.origin))}
          />
        )),
      )}
    </div>
  );
}
