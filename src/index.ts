import type moment from "moment";
import { App, Notice, Plugin } from "obsidian";
import {
  createDailyNote,
  getDailyNote,
  getAllDailyNotes,
} from "obsidian-daily-notes-interface";
import {
  defaultSettings,
  DEFAULT_SECTION_HEADING,
  DEFAULT_TAG_PREFIX,
  ISettings,
  ThingsLogbookSettingsTab,
} from "./settings";

import {
  buildTasksFromSQLRecords,
  getChecklistItemsFromThingsLogbook,
  getTasksFromThingsLogbook,
  ISubTask,
  ITask,
} from "./things";
import {
  getHeadingLevel,
  groupBy,
  isMacOS,
  toHeading,
  updateSection,
} from "./utils";

declare global {
  interface Window {
    app: App;
    moment: typeof moment;
  }
}

export default class ThingsLogbookPlugin extends Plugin {
  public options: ISettings;
  private syncTimeoutId: number;

  async onload(): Promise<void> {
    if (!isMacOS()) {
      console.info(
        "Failed to load Things Logbook plugin. Platform not supported"
      );
      return;
    }

    this.scheduleNextSync = this.scheduleNextSync.bind(this);
    this.syncLogbook = this.syncLogbook.bind(this);
    this.renderTask = this.renderTask.bind(this);

    this.addCommand({
      id: "sync-things-logbook",
      name: "Sync",
      callback: () => setTimeout(this.syncLogbook, 10),
    });

    await this.loadOptions();

    this.addSettingTab(new ThingsLogbookSettingsTab(this.app, this));

    if (this.app.workspace.layoutReady) {
      this.scheduleNextSync();
    } else {
      this.registerEvent(
        this.app.workspace.on("layout-ready", this.scheduleNextSync)
      );
    }
  }

  async syncLogbook(): Promise<void> {
    const dailyNotes = getAllDailyNotes();
    const latestSyncTime = this.options.latestSyncTime || 0;
    const taskRecords = await getTasksFromThingsLogbook(latestSyncTime);
    const checklistRecords = await getChecklistItemsFromThingsLogbook(
      latestSyncTime
    );

    const tasks: ITask[] = buildTasksFromSQLRecords(
      taskRecords,
      checklistRecords
    );

    const daysToTasks: Record<string, ITask[]> = groupBy(
      tasks.filter((task) => task.stopDate),
      (task) => window.moment.unix(task.stopDate).startOf("day").format()
    );

    const jobPromises: Promise<void>[] = Object.entries(daysToTasks).map(
      async ([dateStr, tasks]) => {
        const date = window.moment(dateStr);

        let dailyNote = getDailyNote(date, dailyNotes);
        if (!dailyNote) {
          dailyNote = await createDailyNote(date);
        }
        return updateSection(dailyNote, "## Logbook", this.renderTasks(tasks));
      }
    );

    Promise.all(jobPromises).then(() => {
      new Notice("Things Logbook sync complete");
      this.writeOptions(() => ({ latestSyncTime: window.moment().unix() }));
      this.scheduleNextSync();
    });
  }

  renderTask(task: ITask): string {
    const prefix = this.options.tagPrefix ?? DEFAULT_TAG_PREFIX;
    const tags = task.tags
      .filter((tag) => !!tag)
      .map((tag) => `#${prefix}${tag}`)
      .join(" ");

    return [
      `- [x] ${task.title} ${tags}`.trimEnd(),
      ...task.subtasks.map(
        (subtask: ISubTask) =>
          `  - [${subtask.completed ? "x" : " "}] ${subtask.title}`
      ),
    ].join("\n");
  }

  renderTasks(tasks: ITask[]): string {
    const { sectionHeading = DEFAULT_SECTION_HEADING } = this.options;
    const areas = groupBy<ITask>(tasks, (task) => task.area || "");
    const headingLevel = getHeadingLevel(sectionHeading);

    const output = [sectionHeading];
    Object.entries(areas).map(([area, tasks]) => {
      if (area !== "") {
        output.push(toHeading(area, headingLevel + 1));
      }
      output.push(...tasks.map(this.renderTask));
    });

    return output.join("\n");
  }

  scheduleNextSync(): void {
    const now = window.moment().unix();

    const options = { ...defaultSettings, ...this.options };
    const { latestSyncTime, syncInterval } = options;
    const syncIntervalMs = syncInterval * 1000;
    const nextSync = Math.max(latestSyncTime + syncIntervalMs - now, 0);

    if (this.syncTimeoutId !== undefined) {
      window.clearTimeout(this.syncTimeoutId);
    }
    this.syncTimeoutId = window.setTimeout(this.syncLogbook, nextSync);
  }

  async loadOptions(): Promise<void> {
    this.options = (await this.loadData()) || {};
  }

  async writeOptions(
    changeOpts: (settings: ISettings) => Partial<ISettings>
  ): Promise<void> {
    const diff = changeOpts(this.options);

    if (diff.syncInterval !== undefined) {
      // reschedule if interval changed
      this.scheduleNextSync();
    }

    this.options = { ...this.options, ...diff };
    await this.saveData(this.options);
  }
}
