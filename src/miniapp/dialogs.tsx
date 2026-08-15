/**
 * Modal chrome shared by every overlay: the scroll-lock/Escape/BackButton
 * hook, the confirm dialog, and the full-screen text editors.
 */
import { Check, Maximize2, X } from "lucide-react";
import {
  type MouseEvent,
  type ReactElement,
  type TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { confirmDiscardChanges, useTelegramBackButton, useUnsavedChanges } from "./telegram.js";
import { Button, Caption } from "./ui.js";

/**
 * Overlay chrome: locks body scroll while mounted, and closes on Escape or
 * the Telegram BackButton while `enabled` (pass false while a mutation is in
 * flight to make the overlay non-dismissable).
 */
export function useModalChrome(onClose: () => void, enabled = true): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useTelegramBackButton(enabled ? () => onCloseRef.current() : undefined);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && enabledRef.current) onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}

interface ConfirmDialogProps {
  readonly title: string;
  readonly description: string;
  readonly facts?: readonly (readonly [label: string, value: string])[] | undefined;
  readonly error: string | undefined;
  readonly busy: boolean;
  readonly confirmLabel: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps): ReactElement {
  useModalChrome(props.onCancel, !props.busy);
  const dialogId = useId();
  const dismissBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget && !props.busy) props.onCancel();
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop dismisses on click; Escape is handled while the dialog is open.
    <div className="resetDialogBackdrop" onMouseDown={dismissBackdrop}>
      <section
        className="resetDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${dialogId}-title`}
        aria-describedby={`${dialogId}-description`}
      >
        <h2 id={`${dialogId}-title`}>{props.title}</h2>
        <p id={`${dialogId}-description`}>{props.description}</p>
        {props.facts === undefined || props.facts.length === 0 ? undefined : (
          <dl className="resetDialogFacts">
            {props.facts.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {props.error === undefined ? undefined : (
          <Caption className="resetDialogError" role="alert">
            {props.error}
          </Caption>
        )}
        <div className="resetDialogActions">
          <Button type="button" mode="bezeled" disabled={props.busy} onClick={props.onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            className="resetConfirmApply"
            loading={props.busy}
            autoFocus
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </Button>
        </div>
      </section>
    </div>
  );
}

interface ExpandableTextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> {
  readonly label: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
}

export function ExpandableTextarea({
  label,
  value,
  onValueChange,
  className,
  disabled,
  id,
  rows,
  ...textareaProps
}: ExpandableTextareaProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <div className="expandableTextarea">
        <textarea
          {...textareaProps}
          id={id}
          className={className}
          value={value}
          rows={rows}
          disabled={disabled}
          onChange={(event) => onValueChange(event.currentTarget.value)}
        />
        <button
          type="button"
          className="expandTextareaButton"
          aria-label={`Edit ${label} full screen`}
          title="Edit full screen"
          disabled={disabled}
          onClick={() => setExpanded(true)}
        >
          <Maximize2 aria-hidden="true" />
        </button>
      </div>
      {expanded ? (
        <FullscreenTextEditor
          label={label}
          initialValue={value}
          textareaProps={textareaProps}
          onApply={(nextValue) => {
            onValueChange(nextValue);
            setExpanded(false);
          }}
          onCancel={() => setExpanded(false)}
        />
      ) : undefined}
    </>
  );
}

interface FullscreenTextEditorProps {
  readonly label: string;
  readonly initialValue: string;
  readonly textareaProps: Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "className" | "disabled" | "id" | "onChange" | "rows" | "value"
  >;
  readonly onApply: (value: string) => void;
  readonly onCancel: () => void;
}

function FullscreenTextEditor(props: FullscreenTextEditorProps): ReactElement {
  const [value, setValue] = useState(props.initialValue);
  const textareaId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dirty = value !== props.initialValue;
  useUnsavedChanges(dirty);

  const close = useCallback((): void => {
    if (!dirty) {
      props.onCancel();
      return;
    }
    void confirmDiscardChanges(`Discard changes to ${props.label}?`).then((confirmed) => {
      if (confirmed) props.onCancel();
    });
  }, [dirty, props.label, props.onCancel]);
  useModalChrome(close);

  useEffect(() => {
    const textarea = textareaRef.current;
    textarea?.focus();
    textarea?.setSelectionRange(props.initialValue.length, props.initialValue.length);
  }, [props.initialValue.length]);

  return (
    <section
      className="fullscreenEditor"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${textareaId}-title`}
    >
      <header className="fullscreenEditorHeader">
        <Button
          type="button"
          mode="plain"
          size="s"
          className="fullscreenEditorClose"
          onClick={close}
        >
          <X className="size-5" aria-hidden="true" />
          <span className="fullscreenEditorCloseLabel">Cancel</span>
        </Button>
        <div className="fullscreenEditorHeading">
          <strong id={`${textareaId}-title`}>{props.label}</strong>
          <Caption>{dirty ? "Draft not applied" : "Editing draft"}</Caption>
        </div>
        <Button
          type="button"
          size="s"
          className="fullscreenEditorApply"
          onClick={() => props.onApply(value)}
        >
          <Check className="size-4" aria-hidden="true" />
          Apply
        </Button>
      </header>
      <div className="fullscreenEditorBody">
        <textarea
          {...props.textareaProps}
          ref={textareaRef}
          id={textareaId}
          className="fullscreenEditorTextarea"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      </div>
      <footer className="fullscreenEditorFooter">
        <Caption>
          {value.length.toLocaleString()}
          {props.textareaProps.maxLength === undefined
            ? " characters"
            : ` / ${Number(props.textareaProps.maxLength).toLocaleString()}`}
        </Caption>
        <Caption>Apply returns this draft to the form. Save the form to persist it.</Caption>
      </footer>
    </section>
  );
}
