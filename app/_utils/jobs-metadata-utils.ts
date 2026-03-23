import { readFile, writeFile, readdir, unlink, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

export interface JobMetadata {
  id: string;
  comment?: string;
  logsEnabled: boolean;
  schedule: string;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
}

const METADATA_DIR = path.join(process.cwd(), "data", "jobs-metadata");

async function ensureDir(): Promise<void> {
  if (!existsSync(METADATA_DIR)) {
    await mkdir(METADATA_DIR, { recursive: true });
  }
}

function metadataPath(id: string): string {
  return path.join(METADATA_DIR, `${id}.json`);
}

export async function readJobMetadata(
  id: string
): Promise<JobMetadata | null> {
  try {
    const filePath = metadataPath(id);
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as JobMetadata;
  } catch {
    return null;
  }
}

export async function writeJobMetadata(
  id: string,
  meta: JobMetadata
): Promise<void> {
  await ensureDir();
  const filePath = metadataPath(id);
  await writeFile(filePath, JSON.stringify(meta, null, 2), "utf-8");
}

export async function deleteJobMetadata(id: string): Promise<void> {
  try {
    await unlink(metadataPath(id));
  } catch {
    // File may not exist
  }
}

export async function listAllJobMetadata(): Promise<JobMetadata[]> {
  await ensureDir();
  try {
    const files = await readdir(METADATA_DIR);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    const results: JobMetadata[] = [];

    for (const file of jsonFiles) {
      try {
        const content = await readFile(
          path.join(METADATA_DIR, file),
          "utf-8"
        );
        results.push(JSON.parse(content) as JobMetadata);
      } catch {
        // Skip corrupted files
      }
    }

    return results;
  } catch {
    return [];
  }
}
