import * as SliderPrimitive from "@radix-ui/react-slider";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cva } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type ElementType,
  forwardRef,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "./cn.js";

const buttonVariants = cva(
  "ui-button inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold transition-[background,color,opacity,transform] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 active:scale-[0.985]",
  {
    variants: {
      mode: {
        filled: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
        bezeled: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        plain: "bg-transparent text-primary hover:bg-primary/10",
      },
      size: {
        s: "min-h-10 px-3",
        m: "min-h-11 px-4",
        l: "min-h-12 px-5 text-base",
      },
    },
    defaultVariants: {
      mode: "filled",
      size: "m",
    },
  },
);

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly mode?: "filled" | "bezeled" | "plain";
  readonly size?: "s" | "m" | "l";
  readonly stretched?: boolean;
  readonly loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, mode, size, stretched, loading, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(buttonVariants({ mode, size }), stretched && "w-full", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : undefined}
      {children}
    </button>
  );
});

interface AppRootProps extends HTMLAttributes<HTMLDivElement> {
  readonly appearance: "dark" | "light";
}

export function AppRoot({ appearance, className, children, ...props }: AppRootProps): ReactElement {
  return (
    <div
      className={cn("min-h-svh bg-background text-foreground", appearance, className)}
      data-theme={appearance}
      {...props}
    >
      {children}
    </div>
  );
}

interface SectionProps extends HTMLAttributes<HTMLElement> {
  readonly header?: ReactNode;
  readonly footer?: ReactNode;
}

export function Section({
  header,
  footer,
  className,
  children,
  ...props
}: SectionProps): ReactElement {
  return (
    <section className={cn("ui-section min-w-0", className)} {...props}>
      {header === undefined ? undefined : <div className="ui-section-header">{header}</div>}
      <div className="ui-section-body min-w-0 overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-sm">
        {children}
      </div>
      {footer === undefined ? undefined : <div className="ui-section-footer">{footer}</div>}
    </section>
  );
}

interface CellProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  readonly subtitle?: ReactNode;
  readonly before?: ReactNode;
  readonly after?: ReactNode;
  readonly multiline?: boolean;
  readonly children?: ReactNode;
}

export function Cell({
  subtitle,
  before,
  after,
  multiline,
  className,
  children,
  type,
  ...props
}: CellProps): ReactElement {
  return (
    <button
      type={type ?? "button"}
      className={cn(
        "ui-cell flex min-h-14 w-full min-w-0 items-center gap-3 border-0 bg-transparent px-4 py-3 text-left text-foreground outline-none transition-colors",
        "cursor-pointer hover:bg-accent/70 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-accent",
        className,
      )}
      {...props}
    >
      {before === undefined ? undefined : <span className="ui-cell-before">{before}</span>}
      <span className="min-w-0 flex-1">
        <span className="block min-w-0 truncate text-[15px] font-medium leading-5">{children}</span>
        {subtitle === undefined ? undefined : (
          <span
            className={cn(
              "mt-1 block min-w-0 text-[13px] leading-[18px] text-muted-foreground",
              multiline ? "ui-line-clamp-2" : "truncate",
            )}
          >
            {subtitle}
          </span>
        )}
      </span>
      {after === undefined ? undefined : <span className="ui-cell-after shrink-0">{after}</span>}
    </button>
  );
}

interface BannerProps extends HTMLAttributes<HTMLDivElement> {
  readonly header: ReactNode;
  readonly subheader?: ReactNode;
}

export function Banner({
  header,
  subheader,
  className,
  children,
  ...props
}: BannerProps): ReactElement {
  return (
    <div
      className={cn(
        "rounded-2xl border border-destructive/25 bg-destructive/8 p-4 text-foreground",
        className,
      )}
      role="alert"
      {...props}
    >
      <div className="text-sm font-semibold">{header}</div>
      {subheader === undefined ? undefined : (
        <div className="mt-1 text-sm leading-5 text-muted-foreground">{subheader}</div>
      )}
      {children === undefined ? undefined : <div className="mt-3">{children}</div>}
    </div>
  );
}

interface PlaceholderProps extends HTMLAttributes<HTMLDivElement> {
  readonly header: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
}

export function Placeholder({
  header,
  description,
  action,
  className,
  children,
  ...props
}: PlaceholderProps): ReactElement {
  return (
    <div
      className={cn(
        "mx-auto grid w-full max-w-sm justify-items-center gap-3 px-6 text-center",
        className,
      )}
      {...props}
    >
      {children}
      <div className="text-base font-semibold">{header}</div>
      {description === undefined ? undefined : (
        <div className="text-sm leading-5 text-muted-foreground">{description}</div>
      )}
      {action === undefined ? undefined : <div className="pt-1">{action}</div>}
    </div>
  );
}

interface SpinnerProps extends HTMLAttributes<SVGSVGElement> {
  readonly size?: "m" | "l";
}

export function Spinner({ size = "m", className, ...props }: SpinnerProps): ReactElement {
  return (
    <LoaderCircle
      className={cn("animate-spin text-primary", size === "l" ? "size-8" : "size-5", className)}
      aria-label="Loading"
      {...props}
    />
  );
}

interface SwitchProps {
  readonly id?: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly "aria-label"?: string;
}

export function Switch(props: SwitchProps): ReactElement {
  return (
    <SwitchPrimitive.Root
      id={props.id}
      checked={props.checked}
      disabled={props.disabled === true}
      onCheckedChange={props.onCheckedChange}
      aria-label={props["aria-label"]}
      className="ui-switch inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
    >
      <SwitchPrimitive.Thumb className="ui-switch-thumb pointer-events-none block size-6 rounded-full shadow-md transition-[background,transform] data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0" />
    </SwitchPrimitive.Root>
  );
}

interface SliderProps {
  readonly className?: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  readonly disabled?: boolean;
  readonly getAriaLabel?: () => string;
  readonly getAriaValueText?: (value: number) => string;
  readonly onValueChange: (value: number) => void;
}

export function Slider(props: SliderProps): ReactElement {
  return (
    <SliderPrimitive.Root
      className={cn(
        "relative flex w-full touch-none select-none items-center data-[disabled]:opacity-50",
        props.className,
      )}
      min={props.min}
      max={props.max}
      step={props.step}
      value={[props.value]}
      disabled={props.disabled === true}
      onValueChange={(value) => props.onValueChange(value[0] ?? props.value)}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-secondary">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        className="block size-5 rounded-full border-2 border-primary bg-background shadow-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
        aria-label={props.getAriaLabel?.()}
        aria-valuetext={props.getAriaValueText?.(props.value)}
      />
    </SliderPrimitive.Root>
  );
}

interface TypographyProps extends HTMLAttributes<HTMLElement> {
  readonly Component?: ElementType;
  readonly htmlFor?: string;
}

export function Caption({
  Component = "span",
  className,
  children,
  ...props
}: TypographyProps): ReactElement {
  const Root = Component;
  return (
    <Root className={cn("text-sm leading-5", className)} {...props}>
      {children}
    </Root>
  );
}

export function Headline({
  Component = "h2",
  className,
  children,
  ...props
}: TypographyProps): ReactElement {
  const Root = Component;
  return (
    <Root className={cn("text-2xl font-semibold tracking-tight", className)} {...props}>
      {children}
    </Root>
  );
}

interface TabbarProps extends HTMLAttributes<HTMLElement> {
  readonly children?: ReactNode;
}

interface TabbarItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly selected: boolean;
  readonly text: string;
}

function TabbarRoot({ className, children, ...props }: TabbarProps): ReactElement {
  return (
    <nav
      className={cn(
        "ui-tabbar fixed inset-x-0 bottom-0 z-40 border-t border-border px-3 pt-2 pb-[max(8px,env(safe-area-inset-bottom))] backdrop-blur-xl",
        className,
      )}
      {...props}
    >
      <div className="mx-auto grid w-full max-w-md grid-cols-3 gap-1">{children}</div>
    </nav>
  );
}

function TabbarItem({
  selected,
  text,
  className,
  children,
  ...props
}: TabbarItemProps): ReactElement {
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-xl border-0 bg-transparent text-xs font-medium text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-primary/10 text-primary",
        className,
      )}
      aria-current={selected ? "page" : undefined}
      {...props}
    >
      <span className="[&>svg]:size-6">{children}</span>
      <span>{text}</span>
    </button>
  );
}

export const Tabbar = Object.assign(TabbarRoot, { Item: TabbarItem });
