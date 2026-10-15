export {};

declare global {
  interface Window {
    showDirectoryPicker(options?: {
      id?: string;
      mode?: "read" | "readwrite";
      // A file handle is accepted too: the picker then opens in that file's
      // parent directory, which is what lets "open file" grant the containing
      // folder without the user navigating to it themselves.
      startIn?: string | FileSystemHandle;
    }): Promise<FileSystemDirectoryHandle>;
    showOpenFilePicker(options?: {
      id?: string;
      multiple?: boolean;
      excludeAcceptAllOption?: boolean;
      types?: { description?: string; accept: Record<string, string[]> }[];
      startIn?: string | FileSystemHandle;
    }): Promise<FileSystemFileHandle[]>;
  }
}
