export const CLI_COMMAND_NAME = "omz";
export const CLI_PROCESS_NAME = "omz-cli";

interface ProcessTitleTarget {
  title: string;
}

export const setCliProcessTitle = (
  target: ProcessTitleTarget = process,
): void => {
  target.title = CLI_PROCESS_NAME;
};
