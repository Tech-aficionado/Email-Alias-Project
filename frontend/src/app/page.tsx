import Link from "next/link";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import ProductHuntBadge from "@/components/ProductHuntBadge";

const features = [
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
    ),
    title: "Total Privacy",
    description: "Your real email stays invisible. Services only see your alias — never the real you.",
    tag: "Privacy",
  },
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
    ),
    title: "Kill Spam Instantly",
    description: "Getting spam? Disable the alias and it vanishes. Your real inbox stays pristine.",
    tag: "Control",
  },
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    ),
    title: "Catch Data Sellers",
    description: "Use unique aliases per service. Instantly identify who leaked or sold your email.",
    tag: "Detection",
  },
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    ),
    title: "One-Click Create",
    description: "Generate a new alias instantly. No configuration, no waiting, no complexity.",
    tag: "Speed",
  },
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
    ),
    title: "Seamless Forwarding",
    description: "Emails flow through your alias to your real inbox. Reply-to is preserved perfectly.",
    tag: "Delivery",
  },
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
    ),
    title: "Built for Security",
    description: "Encrypted tokens, rate limiting, and hardened infrastructure protect your data.",
    tag: "Security",
  },
];

const steps = [
  {
    number: "01",
    title: "Create Account",
    description: "Sign up with your real email. It stays hidden and encrypted from day one.",
  },
  {
    number: "02",
    title: "Generate Aliases",
    description: "Create random or custom aliases for each service you interact with.",
  },
  {
    number: "03",
    title: "Use Everywhere",
    description: "Give out your alias anywhere. All emails forward invisibly to your real inbox.",
  },
  {
    number: "04",
    title: "Stay in Control",
    description: "Disable, delete, or monitor any alias from your real-time dashboard.",
  },
];

const useCases = [
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
    ),
    title: "SaaS Signups",
    description: "Use a unique alias for every tool. If one gets breached, your real email stays safe.",
  },
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
    ),
    title: "Online Shopping",
    description: "Give stores disposable aliases. Disable them the moment the order arrives.",
  },
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
    ),
    title: "Freelance Work",
    description: "One alias per client. When the project ends, disable it — no lingering spam.",
  },
];

const stats = [
  { value: "100%", label: "Private by Design" },
  { value: "20", label: "Aliases Per Account" },
  { value: "<50ms", label: "Avg Delivery" },
  { value: "250+", label: "Edge Locations" },
];

export default function HomePage() {
  return (
    <>
      <Navbar />

      {/* Hero */}
      <section className="hero-glow relative mesh-bg pt-28 sm:pt-36 pb-20 sm:pb-32 px-4 sm:px-6">
        <div className="max-w-5xl mx-auto text-center relative z-10">
          {/* Badge */}
          <div className="inline-flex items-center gap-2.5 bg-[var(--relay-primary)]/8 border border-[var(--relay-primary)]/20 text-[var(--relay-primary)] text-xs font-medium px-4 py-2 rounded-full mb-8 sm:mb-10 backdrop-blur-sm">
            <span className="w-1.5 h-1.5 bg-[var(--relay-success)] rounded-full animate-pulse-soft"></span>
            Privacy-first email aliasing — powered by Cloudflare&apos;s edge network
          </div>

          <h1 className="text-3xl sm:text-5xl md:text-7xl lg:text-8xl font-extrabold mb-6 sm:mb-8 leading-[1.1] tracking-tight">
            <span className="text-[var(--relay-text)]">Your Emails,</span>
            <br />
            <span className="relay-gradient-text">Invisible to the World</span>
          </h1>

          <p className="text-sm sm:text-base md:text-lg text-[var(--relay-text-muted)] mb-10 sm:mb-14 max-w-xl mx-auto leading-relaxed px-2">
            Generate email aliases that forward to your real inbox. Protect your
            identity from spam, breaches, and tracking — all in one click.
          </p>

          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4 mb-8 sm:mb-10 px-4 sm:px-0">
            <Link
              href="/dashboard"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-[var(--relay-primary)] hover:bg-[var(--relay-primary-hover)] text-white font-semibold px-8 py-4 rounded-lg text-sm transition-smooth hover:-translate-y-0.5 btn-glow"
            >
              Start For Free
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            </Link>
            <Link
              href="#how-it-works"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 border border-[var(--relay-border)] hover:border-[var(--relay-primary)]/50 text-[var(--relay-text-muted)] hover:text-[var(--relay-text)] font-medium px-8 py-4 rounded-lg text-sm transition-smooth"
            >
              See How It Works
            </Link>
          </div>

          {/* Product Hunt */}
          <div className="flex justify-center mb-14 sm:mb-20">
            <ProductHuntBadge />
          </div>

          {/* Email demo visualization */}
          <div className="inline-flex items-center gap-4 sm:gap-6 glass-card px-5 sm:px-8 py-5 sm:py-7 rounded-xl flex-col sm:flex-row justify-center animate-glow-pulse">
            <div className="text-center">
              <span className="text-[10px] text-[var(--relay-text-dim)] uppercase tracking-widest block mb-2.5 font-semibold">
                Your real email
              </span>
              <span className="font-mono text-xs sm:text-sm bg-[var(--relay-danger)]/10 text-[var(--relay-danger)] px-3 sm:px-4 py-2 rounded-md line-through inline-block border border-[var(--relay-danger)]/10">
                you@gmail.com
              </span>
            </div>
            <div className="flex items-center gap-2 rotate-90 sm:rotate-0">
              <div className="w-8 h-[1px] sm:w-10 bg-[var(--relay-border)]"></div>
              <div className="w-8 h-8 rounded-lg relay-gradient flex items-center justify-center">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
              </div>
              <div className="w-8 h-[1px] sm:w-10 bg-[var(--relay-border)]"></div>
            </div>
            <div className="text-center">
              <span className="text-[10px] text-[var(--relay-text-dim)] uppercase tracking-widest block mb-2.5 font-semibold">
                What services see
              </span>
              <span className="font-mono text-xs sm:text-sm bg-[var(--relay-success)]/10 text-[var(--relay-success)] px-3 sm:px-4 py-2 rounded-md inline-block border border-[var(--relay-success)]/10">
                a7x9k2m@ghostrelay.me
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="px-6 md:px-10 lg:px-16 py-20 max-w-5xl mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {stats.map((stat) => (
            <div key={stat.label} className="stat-card glass-card p-6 rounded-xl text-center">
              <div className="text-3xl md:text-4xl font-extrabold relay-gradient-text mb-1">{stat.value}</div>
              <div className="text-xs text-[var(--relay-text-muted)] uppercase tracking-wider font-medium">{stat.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Built With */}
      <section className="px-6 md:px-10 lg:px-16 py-12 max-w-5xl mx-auto text-center">
        <p className="text-[10px] text-[var(--relay-text-dim)] uppercase tracking-[0.2em] font-semibold mb-8">Built with</p>
        <div className="flex flex-wrap items-center justify-center gap-10 text-[var(--relay-text-dim)]">
          {["Cloudflare Workers", "Cloudflare D1", "Next.js", "React 19", "Tailwind CSS", "Resend"].map((tech) => (
            <span key={tech} className="text-base font-bold opacity-30 hover:opacity-60 transition-opacity">{tech}</span>
          ))}
        </div>
      </section>

      {/* Features */}
      <section id="features" className="px-6 md:px-10 lg:px-16 py-28 max-w-6xl mx-auto grid-pattern">
        <div className="text-center mb-20">
          <div className="accent-line w-12 mx-auto mb-6"></div>
          <h2 className="text-3xl md:text-5xl font-bold mb-5 tracking-tight">Why GhostRelay?</h2>
          <p className="text-[var(--relay-text-muted)] max-w-md mx-auto text-base">
            The email privacy tool built for people who care about their data.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="feature-card glass-card p-7 rounded-xl text-left group"
            >
              <div className="flex items-center justify-between mb-5">
                <div className="w-11 h-11 rounded-lg bg-[var(--relay-primary)]/8 border border-[var(--relay-primary)]/15 flex items-center justify-center text-[var(--relay-primary)] group-hover:bg-[var(--relay-primary)]/15 transition-smooth">
                  {feature.icon}
                </div>
                <span className="badge-pill bg-[var(--relay-card-hover)] text-[var(--relay-text-dim)] border border-[var(--relay-border)]">
                  {feature.tag}
                </span>
              </div>
              <h3 className="text-base font-semibold mb-2 text-[var(--relay-text)]">
                {feature.title}
              </h3>
              <p className="text-[var(--relay-text-muted)] text-sm leading-relaxed">{feature.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="px-6 md:px-10 lg:px-16 py-28 max-w-5xl mx-auto">
        <div className="text-center mb-20">
          <div className="accent-line w-12 mx-auto mb-6"></div>
          <h2 className="text-3xl md:text-5xl font-bold mb-5 tracking-tight">Set Up in Minutes</h2>
          <p className="text-[var(--relay-text-muted)] text-base">
            Four steps to complete email privacy.
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
          {steps.map((step, index) => (
            <div key={step.number} className="relative">
              {index < steps.length - 1 && (
                <div className="hidden lg:block absolute top-7 left-[65%] w-[70%] h-[1px] bg-gradient-to-r from-[var(--relay-primary)]/30 to-transparent"></div>
              )}
              <div className="glass-card p-6 rounded-xl text-center h-full">
                <div className="w-14 h-14 relay-gradient rounded-xl flex items-center justify-center text-sm font-bold mx-auto mb-5 text-white shadow-lg shadow-teal-500/20">
                  {step.number}
                </div>
                <h3 className="font-semibold text-base mb-2 text-[var(--relay-text)]">
                  {step.title}
                </h3>
                <p className="text-[var(--relay-text-muted)] text-sm leading-relaxed">{step.description}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Use Cases */}
      <section className="px-6 md:px-10 lg:px-16 py-28 max-w-6xl mx-auto">
        <div className="text-center mb-20">
          <div className="accent-line w-12 mx-auto mb-6"></div>
          <h2 className="text-3xl md:text-5xl font-bold mb-5 tracking-tight">Built for Real Scenarios</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {useCases.map((uc) => (
            <div key={uc.title} className="glass-card p-7 rounded-xl">
              <div className="w-11 h-11 rounded-lg bg-[var(--relay-primary)]/8 border border-[var(--relay-primary)]/15 flex items-center justify-center text-[var(--relay-primary)] mb-5">
                {uc.icon}
              </div>
              <h3 className="text-base font-semibold mb-2 text-[var(--relay-text)]">{uc.title}</h3>
              <p className="text-[var(--relay-text-muted)] text-sm leading-relaxed">{uc.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Free Forever */}
      <section id="pricing" className="px-6 md:px-10 lg:px-16 py-28 max-w-4xl mx-auto">
        <div className="text-center mb-14">
          <div className="accent-line w-12 mx-auto mb-6"></div>
          <h2 className="text-3xl md:text-5xl font-bold mb-5 tracking-tight">Simple Pricing. No Surprises.</h2>
          <p className="text-[var(--relay-text-muted)] text-base">
            Everything you need to protect your email privacy — included in one plan.
          </p>
        </div>
        <div className="glass-card p-10 rounded-xl max-w-md mx-auto text-center relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-[2px] relay-gradient"></div>
          <div className="text-5xl font-extrabold mb-2 text-[var(--relay-text)]">Free</div>
          <p className="text-[var(--relay-text-dim)] text-sm mb-8 uppercase tracking-wider font-medium">no credit card required</p>
          <ul className="space-y-3 mb-10 text-left max-w-xs mx-auto">
            {["Up to 20 email aliases", "Unlimited forwarding", "Custom alias names", "Enable/disable anytime", "Privacy dashboard & analytics", "No ads, no tracking"].map((item) => (
              <li key={item} className="text-[var(--relay-text-muted)] text-sm flex items-start gap-3">
                <svg className="w-4 h-4 text-[var(--relay-primary)] mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                {item}
              </li>
            ))}
          </ul>
          <Link href="/dashboard" className="inline-flex items-center gap-2 bg-[var(--relay-primary)] hover:bg-[var(--relay-primary-hover)] text-white font-semibold px-8 py-3.5 rounded-lg transition-smooth btn-glow text-sm">
            Get Started Free
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
          </Link>
        </div>
      </section>

      {/* FAQ */}
      <section className="px-6 md:px-10 lg:px-16 py-28 max-w-3xl mx-auto">
        <div className="text-center mb-14">
          <div className="accent-line w-12 mx-auto mb-6"></div>
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight">Frequently Asked Questions</h2>
        </div>
        <div className="space-y-3">
          {[
            { q: "Is my real email address truly hidden?", a: "Yes. Services only see your alias. Your real email is never exposed — it's stored securely and only used for forwarding." },
            { q: "Can I reply to forwarded emails?", a: "The Reply-To header is set to the original sender, so hitting reply goes directly to them." },
            { q: "What happens when I disable an alias?", a: "Emails sent to that alias are silently rejected. The sender gets a bounce. No emails reach your inbox." },
            { q: "How many aliases can I create?", a: "Every account gets up to 20 email aliases — completely free, no ads, no tracking." },
            { q: "Which email providers work?", a: "All of them. Gmail, Outlook, Yahoo, ProtonMail, iCloud — any email address can receive forwarded emails." },
          ].map((faq) => (
            <div key={faq.q} className="glass-card p-6 rounded-xl">
              <h3 className="font-semibold text-[var(--relay-text)] mb-2 text-sm">{faq.q}</h3>
              <p className="text-[var(--relay-text-muted)] text-sm leading-relaxed">{faq.a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="text-center px-6 py-32 mesh-bg hero-glow relative">
        <div className="relative z-10 max-w-2xl mx-auto">
          <h2 className="text-3xl md:text-5xl font-bold mb-5 tracking-tight">Ready to Go Invisible?</h2>
          <p className="text-[var(--relay-text-muted)] mb-10 max-w-md mx-auto text-base">
            Keep your real email private. Takes 30 seconds to start.
          </p>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 bg-[var(--relay-primary)] hover:bg-[var(--relay-primary-hover)] text-white font-semibold px-8 py-4 rounded-lg text-sm transition-smooth hover:-translate-y-0.5 btn-glow"
          >
            Create Your First Alias
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
          </Link>
        </div>
      </section>

      <Footer />

      {/* JSON-LD */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "GhostRelay",
            applicationCategory: "SecurityApplication",
            operatingSystem: "Web",
            description: "Create email aliases that forward to your real inbox. Protect your identity from spam and data breaches.",
            url: "https://www.ghostrelay.me",
            offers: [
              { "@type": "Offer", price: "0", priceCurrency: "USD", name: "Free" },
            ],
          }),
        }}
      />
    </>
  );
}
