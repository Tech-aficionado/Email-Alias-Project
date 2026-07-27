const PH_URL =
  "https://www.producthunt.com/products/ghostrelay?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-ghostrelay";

const PH_IMAGE =
  "https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1204807";

const ALT =
  "GhostRelay - Free, self-hosted email aliasing. No server. No month bill. | Product Hunt";

type Props = {
  /** Rendered width in px. Height scales with the badge's 250x54 ratio. */
  width?: number;
  className?: string;
};

export default function ProductHuntBadge({ width = 250, className = "" }: Props) {
  const height = Math.round((width * 54) / 250);

  return (
    <a
      href={PH_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="GhostRelay on Product Hunt"
      className={`inline-block transition-smooth hover:-translate-y-0.5 ${className}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${PH_IMAGE}&theme=light&t=1785150460831`}
        alt={ALT}
        width={width}
        height={height}
        className="ph-badge-light"
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${PH_IMAGE}&theme=dark&t=1785150460831`}
        alt={ALT}
        width={width}
        height={height}
        className="ph-badge-dark"
      />
    </a>
  );
}
