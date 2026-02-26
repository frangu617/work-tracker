import Link from "next/link";

export default function AboutPage() {
  return (
    <main className="tracker-app">
      <section className="panel about-panel">
        <p className="tracker-kicker">About</p>
        <h1>Work Tracker</h1>
        <p>Track hours, projects, breaks, and earnings.</p>
        <p>
          Includes one-tap timer, manual logs, last-7-day summaries, calendar drilldowns, and
          export tools.
        </p>
        <Link className="btn btn-ghost" href="/">
          Back to Dashboard
        </Link>
      </section>
    </main>
  );
}
