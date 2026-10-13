const transientDirectories = new Set([".venv", "__pycache__"]);

/** Local runtime artifacts are not source checkpoints, in either executor path. */
export function isTransientRuntimeDirectory(name) {
  return transientDirectories.has(name);
}

/** Trusted image capabilities, shared by trial and repository execution. */
export function withHostedRuntimeInstructions(prompt) {
  return "Runtime environment: this isolated workspace includes Python 3 and its standard library "
    + "(run python3 file.py), python3 -m venv .venv and offline pip, Node.js/npm, Git, bash and basic shell tools. "
    + "Execute and test code inside this workspace with these installed tools. "
    + "There is no general network or host/root access. Third-party Python libraries are not preinstalled; "
    + "only already supplied local wheels can be installed in .venv. "
    + "The repository runner separately prepares approved lockfile dependencies; do not bypass that setup. "
    + "Do not ask the user to run sudo or change the server host to execute a task. "
    + "Explain missing dependencies or other limits honestly, and never claim a program ran without observing its result. "
    + ".venv and __pycache__ are temporary and are not saved to the code branch.\n\n" + prompt;
}
