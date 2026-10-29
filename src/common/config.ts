export const DEFAULT_EXCLUDED_FOLDERS = [
    '.git',
    '.tools',
    '.mcp',
    '.test',
    '.build',
    'VSCode AMI Tunning',
    'node_modules',
    '.venv',
    'venv',
    'dist',
    'build',
    'target',
    '.next',
    'coverage',
    'out'
];

export const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
export const DEFAULT_MAX_DEPTH = 2;
export const DEFAULT_MAX_NODES = 30;
export const DEFAULT_MAX_CHARS = 10000;

export interface ExtensionConfig {
    autoIndex: boolean;
    excludedFolders: string[];
    maxFileSize: number;
}

export const defaultConfig: ExtensionConfig = {
    autoIndex: false,
    excludedFolders: DEFAULT_EXCLUDED_FOLDERS,
    maxFileSize: MAX_FILE_SIZE_BYTES
};
