// Presentation only: each dialog owns its draft and pending-action guards.
export function makeAgentDialogButton({ document: doc, label, kind, onClick, id }) {
  const button = doc.createElement("button"); button.type = "button";
  if (id) button.id = id;
  button.className = kind === "close" ? "icon-button workspace-icon-button agent-dialog-close" : "text-button agent-dialog-back";
  button.setAttribute("data-i18n-skip", "");
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", kind === "close" ? "m6 6 12 12M18 6 6 18" : "m14 7-5 5 5 5"); svg.append(path);
  const caption = doc.createElement("span");
  button.append(svg); if (kind !== "close") button.append(caption);
  button.refreshLabel = value => {
    button.setAttribute("aria-label", value);
    if (kind !== "close") caption.textContent = value;
  };
  button.refreshLabel(label);
  if (onClick) button.addEventListener("click", onClick);
  return button;
}
