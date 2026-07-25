import { PersonaConsole } from "./PersonaConsole";
import { ELORA_PERSONA } from "@vireon/persona-config";

// Route-level wrapper: the only place ELORA_PERSONA is wired to the
// console. Adding a second persona console later means a second thin
// wrapper like this one, not a change to PersonaConsole.tsx.
export function EloraConsolePage() {
  return <PersonaConsole persona={ELORA_PERSONA} />;
}
