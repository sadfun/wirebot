/**
 * Run-once guard for a reply stream's completion: the first `run` executes
 * `finish`, concurrent calls await the same attempt, and a failed attempt
 * resets so completion can be retried. `closed` turns true for the duration
 * of an attempt and stays true once completed, so draft scheduling can stop
 * the moment completion starts.
 */
export class CompletionGuard {
  #closing = false;
  #completing: Promise<void> | undefined;
  #completed = false;

  public get closed(): boolean {
    return this.#closing || this.#completed;
  }

  public async run(finish: () => Promise<void>): Promise<void> {
    if (this.#completed) return;
    if (this.#completing !== undefined) return await this.#completing;

    this.#closing = true;
    const completion = finish();
    this.#completing = completion;
    try {
      await completion;
      this.#completed = true;
    } finally {
      if (this.#completing === completion) this.#completing = undefined;
      if (!this.#completed) this.#closing = false;
    }
  }
}
