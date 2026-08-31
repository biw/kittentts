interface CEPhonemizerFileSystem {
  mkdir(path: string): void;
  writeFile(path: string, data: string): void;
}

interface CEPhonemizerModule {
  FS: CEPhonemizerFileSystem;
  UTF8ToString(pointer: number): string;
  cwrap(
    identifier: string,
    returnType: "number" | null,
    argumentTypes: Array<"number" | "string">,
  ): unknown;
}

declare function createCEPhonemizerModule(): Promise<CEPhonemizerModule>;

export = createCEPhonemizerModule;
