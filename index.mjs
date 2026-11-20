//#region dsh-custom-desktop — Host half
/**
 * Desktop plugin host half. The model-seat UI remains entirely client-side;
 * this route performs authenticated, checked session deletion in the Host.
 */
import { registerSessionDeleteRoute } from "./session-delete.host.mjs";

const name = "custom-desktop";
const inject = ["webServer", "workspaceRegistry", "sessionPersistence"];

function apply(ctx) {
  ctx.effect(() => registerSessionDeleteRoute(ctx), "custom-desktop: permanent session delete");
}

export { apply, inject, name };
//#endregion
