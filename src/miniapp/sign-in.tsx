import { Terminal } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Button } from "./ui.js";

export function SignIn({
  error,
  busy,
  onSignIn,
}: {
  readonly error: string | undefined;
  readonly busy: boolean;
  readonly onSignIn: (token: string) => Promise<void>;
}): ReactElement {
  const [value, setValue] = useState("");
  const [inputError, setInputError] = useState<string>();
  return (
    <main className="signInRoot">
      <section className="signInCard">
        <div className="signInMark">
          <Terminal size={28} aria-hidden="true" />
        </div>
        <p className="eyebrow">WIREBOT</p>
        <h1>
          Your workspace,
          <br />
          wherever you are.
        </h1>
        <p className="signInIntro">
          Manage Codex settings, explore skills, and keep scheduled work on track.
        </p>
        <div className="signInInstructions">
          <h2>Sign in through your bot</h2>
          <p>
            Send <code>/wirebot web</code> in a direct message to your Slack or Discord bot, or{" "}
            <code>/web</code> in Telegram. Open the private link it replies with.
          </p>
          <p>Access is available to Wirebot admins. Links expire after 5 minutes and work once.</p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            let token = value.trim();
            try {
              token = new URL(token).hash.slice("#login=".length);
            } catch {
              /* A raw token is also accepted. */
            }
            if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
              setInputError("Paste the complete sign-in link or token from your bot.");
              return;
            }
            setInputError(undefined);
            setValue("");
            void onSignIn(token);
          }}
        >
          <label htmlFor="login-link">Opening on another device?</label>
          <input
            id="login-link"
            type="password"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Paste your sign-in link"
            disabled={busy}
          />
          {(inputError ?? error) && (
            <p className="signInError" role="alert">
              {inputError ?? error}
            </p>
          )}
          <Button type="submit" size="l" stretched disabled={busy || value.trim().length === 0}>
            {busy ? "Signing in…" : "Continue to Wirebot"}
          </Button>
        </form>
        <p className="signInFootnote">
          Using Telegram? You can also open Settings directly inside the bot.
        </p>
      </section>
    </main>
  );
}
