/** What telling an open pull request apart needs: its state, and whether the code host answered it as gone. */
type OpenFacts = { state: string; goneAt?: string | undefined };

/** Whether the office still sees the pull request: the code host has not answered it as not found or forbidden. */
export const visible = (pr: Pick<OpenFacts, "goneAt">): boolean => !pr.goneAt;

/** An open pull request the office can still read; a gone one counts as not open. */
export const isOpen = (pr: OpenFacts): boolean => pr.state === "open" && visible(pr);
