/**
 * The Skills tab: lists the skills Codex can use and lets the user read a
 * skill's instructions and browse its bundled files.
 */
import { type ReactElement, useCallback, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AvailableSkill } from "../codex/runtime-service.js";
import type { SkillDirectory, SkillFile } from "../codex/skill-browser.js";
import { requestSkillResource, requestSkills } from "./api.js";
import { useAsync } from "./shared.js";
import { nativeTelegramNavigation, useTelegramBackButton } from "./telegram.js";
import { Banner, Button, Caption, Cell, Headline, Placeholder, Section, Spinner } from "./ui.js";

export function SkillsBrowser(): ReactElement {
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [selectedSkill, setSelectedSkill] = useState<AvailableSkill>();
  const [directoryPath, setDirectoryPath] = useState("");
  const [selectedFilePath, setSelectedFilePath] = useState<string>();
  const navigateBack = useCallback((): void => {
    if (selectedFilePath !== undefined) {
      setSelectedFilePath(undefined);
      return;
    }
    if (directoryPath.length > 0) {
      setDirectoryPath(parentDirectory(directoryPath));
      return;
    }
    setSelectedSkill(undefined);
  }, [directoryPath, selectedFilePath]);
  useTelegramBackButton(selectedSkill === undefined ? undefined : navigateBack);

  const skillsLoad = useAsync(requestSkills, [loadAttempt]);
  const documentLoad = useAsync(
    selectedSkill === undefined
      ? undefined
      : async (): Promise<SkillFile> => {
          const resource = await requestSkillResource(selectedSkill.name, "SKILL.md");
          if (resource.type !== "file" || resource.encoding !== "utf8") {
            throw new Error("SKILL.md is not a readable text file.");
          }
          return resource;
        },
    [selectedSkill],
  );
  const directoryLoad = useAsync(
    selectedSkill === undefined
      ? undefined
      : async (): Promise<SkillDirectory> => {
          const resource = await requestSkillResource(selectedSkill.name, directoryPath);
          if (resource.type !== "directory") throw new Error("This path is not a directory.");
          return resource;
        },
    [directoryPath, selectedSkill],
  );
  const fileLoad = useAsync(
    selectedSkill === undefined || selectedFilePath === undefined
      ? undefined
      : async (): Promise<SkillFile> => {
          const resource = await requestSkillResource(selectedSkill.name, selectedFilePath);
          if (resource.type !== "file") throw new Error("This path is not a file.");
          return resource;
        },
    [selectedFilePath, selectedSkill],
  );

  const openSkill = (skill: AvailableSkill): void => {
    setSelectedSkill(skill);
    setDirectoryPath("");
    setSelectedFilePath(undefined);
  };

  if (selectedSkill !== undefined) {
    return (
      <SkillDetail
        skill={selectedSkill}
        skillDocument={documentLoad.value}
        skillDocumentError={documentLoad.error}
        directoryPath={directoryPath}
        directory={directoryLoad.value}
        directoryError={directoryLoad.error}
        selectedFilePath={selectedFilePath}
        selectedFile={fileLoad.value}
        selectedFileError={fileLoad.error}
        onBack={() => setSelectedSkill(undefined)}
        onDirectory={(path) => {
          setDirectoryPath(path);
          setSelectedFilePath(undefined);
        }}
        onFile={setSelectedFilePath}
      />
    );
  }

  const skills = skillsLoad.value;
  if (skills === undefined) {
    if (skillsLoad.error !== undefined) {
      return (
        <div className="loadingRoot tabbedLoadingRoot">
          <Placeholder
            header="Couldn’t load skills"
            description={skillsLoad.error}
            action={
              <Button onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Try again</Button>
            }
          />
        </div>
      );
    }
    return (
      <div className="loadingRoot tabbedLoadingRoot">
        <Placeholder
          header="Loading Codex skills"
          description="Reading the skills currently available to this workspace…"
        >
          <Spinner size="l" />
        </Placeholder>
      </div>
    );
  }

  return (
    <main className="page skillsPage">
      <header className="pageHeader">
        <div>
          <Headline Component="h1">Skills</Headline>
          <Caption className="pageSubtitle">Available to Codex in this workspace</Caption>
        </div>
        <Caption className="revision">{String(skills.length)}</Caption>
      </header>
      {skills.length === 0 ? (
        <Placeholder
          header="No skills available"
          description="Reload Codex after installing or enabling a skill."
        />
      ) : (
        <Section
          header={`${skills.length} ${skills.length === 1 ? "skill" : "skills"}`}
          footer="Open a skill to read its instructions and browse its bundled files."
        >
          {skills.map((skill) => (
            <Cell
              key={skill.name}
              className="skillCell"
              subtitle={skill.description}
              multiline
              after={
                <span className="cellChevron" aria-hidden="true">
                  ›
                </span>
              }
              onClick={() => openSkill(skill)}
            >
              {skill.name}
            </Cell>
          ))}
        </Section>
      )}
    </main>
  );
}

interface SkillDetailProps {
  readonly skill: AvailableSkill;
  readonly skillDocument: SkillFile | undefined;
  readonly skillDocumentError: string | undefined;
  readonly directoryPath: string;
  readonly directory: SkillDirectory | undefined;
  readonly directoryError: string | undefined;
  readonly selectedFilePath: string | undefined;
  readonly selectedFile: SkillFile | undefined;
  readonly selectedFileError: string | undefined;
  readonly onBack: () => void;
  readonly onDirectory: (path: string) => void;
  readonly onFile: (path: string) => void;
}

function SkillDetail(props: SkillDetailProps): ReactElement {
  const parentPath = parentDirectory(props.directoryPath);
  return (
    <main className="page skillsPage">
      <header className="skillDetailHeader">
        {nativeTelegramNavigation ? undefined : (
          <Button mode="plain" size="s" onClick={props.onBack} aria-label="Back to skills">
            ‹ Skills
          </Button>
        )}
        <Headline Component="h1">{props.skill.name}</Headline>
        <Caption className="pageSubtitle">{props.skill.description}</Caption>
      </header>
      <div className="sectionStack">
        <Section
          header="SKILL.md"
          footer="These are the instructions Codex reads when the skill is selected."
        >
          {props.skillDocumentError !== undefined ? (
            <Banner header="Couldn’t read SKILL.md" subheader={props.skillDocumentError} />
          ) : props.skillDocument === undefined ? (
            <div className="resourceLoading">
              <Spinner />
            </div>
          ) : (
            renderMarkdownPreview(props.skillDocument.content, true)
          )}
        </Section>
        <Section
          header={props.directoryPath.length === 0 ? "Files" : props.directoryPath}
          footer="Folders, scripts, references, images, and other resources bundled with this skill."
        >
          {props.directoryPath.length === 0 ? undefined : (
            <Cell
              className="skillCell"
              before={
                <span className="fileIcon" aria-hidden="true">
                  ↰
                </span>
              }
              onClick={() => props.onDirectory(parentPath)}
            >
              {parentPath.length === 0 ? "Skill root" : parentPath}
            </Cell>
          )}
          {props.directoryError !== undefined ? (
            <Banner header="Couldn’t open this folder" subheader={props.directoryError} />
          ) : props.directory === undefined ? (
            <div className="resourceLoading">
              <Spinner />
            </div>
          ) : props.directory.entries.length === 0 ? (
            <Caption className="emptyDirectory">This folder is empty.</Caption>
          ) : (
            props.directory.entries.map((entry) => (
              <Cell
                key={entry.path}
                className="skillCell"
                before={
                  <span className="fileIcon" aria-hidden="true">
                    {entry.type === "directory" ? "▸" : "·"}
                  </span>
                }
                subtitle={
                  entry.type === "file" && entry.size !== null ? formatBytes(entry.size) : undefined
                }
                after={
                  <span className="cellChevron" aria-hidden="true">
                    ›
                  </span>
                }
                onClick={() =>
                  entry.type === "directory"
                    ? props.onDirectory(entry.path)
                    : props.onFile(entry.path)
                }
              >
                {entry.name}
              </Cell>
            ))
          )}
        </Section>
        {props.selectedFilePath === undefined ? undefined : (
          <Section
            header={props.selectedFilePath}
            footer={
              props.selectedFile === undefined
                ? undefined
                : `${formatBytes(props.selectedFile.size)} · ${props.selectedFile.mediaType}`
            }
          >
            {renderFilePreview(props.selectedFile, props.selectedFileError)}
          </Section>
        )}
      </div>
    </main>
  );
}

function renderFilePreview(file: SkillFile | undefined, error: string | undefined): ReactElement {
  if (error !== undefined) {
    return <Banner header="Couldn’t preview this file" subheader={error} />;
  }
  if (file === undefined) {
    return (
      <div className="resourceLoading">
        <Spinner />
      </div>
    );
  }
  if (file.encoding === "utf8") {
    return file.mediaType === "text/markdown" || file.path.toLowerCase().endsWith(".md") ? (
      renderMarkdownPreview(file.content)
    ) : (
      <pre className="skillSource">{file.content}</pre>
    );
  }
  if (file.mediaType.startsWith("image/")) {
    return (
      <div className="imagePreview">
        <img src={`data:${file.mediaType};base64,${file.content}`} alt={file.path} />
      </div>
    );
  }
  return (
    <Caption className="binaryPreview">
      This binary file can be browsed, but it cannot be previewed here.
    </Caption>
  );
}

function renderMarkdownPreview(content: string, stripFrontmatter = false): ReactElement {
  const markdown = stripFrontmatter
    ? content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    : content;
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  );
}

function parentDirectory(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  parts.pop();
  return parts.join("/");
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MB`;
}
