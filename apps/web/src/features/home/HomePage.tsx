import { Link } from "react-router-dom";
import { Card } from "../../components/Card";
import { Button } from "../../components/Button";
import { ELORA_PERSONA } from "@vireon/persona-config";

export function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-shell-bg px-6 py-16">
      <Card glow="cyan" className="max-w-xl text-center">
        <img
          src={ELORA_PERSONA.crestAssetPath}
          alt=""
          aria-hidden="true"
          className="mx-auto mb-6 h-24 w-24 rounded-full border border-accent-cyan/40 shadow-glow-cyan"
        />
        <h1 className="font-heading text-hero font-semibold tracking-hero text-text-primary">Vireon CORE</h1>
        <p className="mt-4 text-lead text-text-secondary">
          A persistent operating environment for human-AI collaboration -- context preserved, intelligence
          coordinated, work carried across time.
        </p>
        <Link to="/elora" className="mt-8 inline-block">
          <Button>Enter the ELORA console</Button>
        </Link>
        <Link to="/deck" className="mt-4 inline-block">
          <Button variant="secondary">Open the Operator Deck</Button>
        </Link>
      </Card>
    </main>
  );
}
