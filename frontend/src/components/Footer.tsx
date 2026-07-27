import Link from "next/link";
import Logo from "./Logo";
import ProductHuntBadge from "./ProductHuntBadge";

export default function Footer() {
  return (
    <footer className="border-t border-[var(--relay-border)] bg-[var(--relay-surface)]">
      <div className="max-w-7xl mx-auto px-6 md:px-10 lg:px-16 py-16">
        {/* Top section with accent line */}
        <div className="accent-line w-24 mb-12"></div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-10">
          {/* Brand */}
          <div className="lg:col-span-1">
            <Logo size={28} showText={true} />
            <p className="text-[var(--relay-text-muted)] text-sm mt-4 leading-relaxed max-w-xs">
              Your real email stays invisible. Create aliases and take full control of your inbox privacy.
            </p>
            <ProductHuntBadge width={215} className="mt-6" />
          </div>

          {/* Product */}
          <div>
            <h4 className="font-semibold text-[var(--relay-text)] mb-5 text-sm tracking-wide uppercase text-xs">Product</h4>
            <ul className="space-y-3">
              <li><Link href="/#features" className="text-sm text-[var(--relay-text-muted)] hover:text-[var(--relay-primary)] transition-colors">Features</Link></li>
              <li><Link href="/#how-it-works" className="text-sm text-[var(--relay-text-muted)] hover:text-[var(--relay-primary)] transition-colors">How It Works</Link></li>
              <li><Link href="/dashboard" className="text-sm text-[var(--relay-text-muted)] hover:text-[var(--relay-primary)] transition-colors">Dashboard</Link></li>
              <li><Link href="/blog" className="text-sm text-[var(--relay-text-muted)] hover:text-[var(--relay-primary)] transition-colors">Changelog</Link></li>
            </ul>
          </div>

          {/* Company */}
          <div>
            <h4 className="font-semibold text-[var(--relay-text)] mb-5 text-sm tracking-wide uppercase text-xs">Company</h4>
            <ul className="space-y-3">
              <li><Link href="/about" className="text-sm text-[var(--relay-text-muted)] hover:text-[var(--relay-primary)] transition-colors">About Us</Link></li>
              <li><Link href="/blog" className="text-sm text-[var(--relay-text-muted)] hover:text-[var(--relay-primary)] transition-colors">Blog</Link></li>
              <li><Link href="/contact" className="text-sm text-[var(--relay-text-muted)] hover:text-[var(--relay-primary)] transition-colors">Contact</Link></li>
              <li><a href="#" className="text-sm text-[var(--relay-text-muted)] hover:text-[var(--relay-primary)] transition-colors">Careers</a></li>
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h4 className="font-semibold text-[var(--relay-text)] mb-5 text-sm tracking-wide uppercase text-xs">Legal</h4>
            <ul className="space-y-3">
              <li><Link href="/privacy" className="text-sm text-[var(--relay-text-muted)] hover:text-[var(--relay-primary)] transition-colors">Privacy Policy</Link></li>
              <li><Link href="/terms" className="text-sm text-[var(--relay-text-muted)] hover:text-[var(--relay-primary)] transition-colors">Terms of Service</Link></li>
              <li><Link href="/privacy#cookies" className="text-sm text-[var(--relay-text-muted)] hover:text-[var(--relay-primary)] transition-colors">Cookie Policy</Link></li>
              <li><Link href="/privacy#your-rights" className="text-sm text-[var(--relay-text-muted)] hover:text-[var(--relay-primary)] transition-colors">GDPR</Link></li>
            </ul>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="border-t border-[var(--relay-border)] mt-12 pt-8 flex flex-col sm:flex-row justify-between items-center gap-4">
          <p className="text-[var(--relay-text-dim)] text-xs">
            © {new Date().getFullYear()} GhostRelay. All rights reserved.
          </p>
          <div className="flex items-center gap-6">
            <span className="flex items-center gap-2 text-xs text-[var(--relay-text-dim)]">
              <span className="w-1.5 h-1.5 bg-[var(--relay-success)] rounded-full animate-pulse-soft"></span>
              All systems operational
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
