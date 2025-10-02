import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { listenerCount } from 'process';
import { runInThisContext } from 'vm';


export class BibItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly paper_name: string = "",
        public level: number = 0,
        public line_start: number = 0,
        public line_end: number = 0,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        this.tooltip = paper_name;
        this.description = paper_name;
        this.level = level;
        this.line_start = line_start;
        this.line_end = line_end;

        this.command = {
            command: "bibItemTree.navigateTo",
            title: "Navigate BibItem",
            arguments: [this]
        }
        if (level != 99) this.contextValue = "header";
        else this.contextValue = 'bibItem';
    }
}


export class BibNodeProvider implements vscode.TreeDataProvider<BibItem> {

	private _onDidChangeTreeData: vscode.EventEmitter<BibItem | undefined | void> = new vscode.EventEmitter<BibItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<BibItem | undefined | void> = this._onDidChangeTreeData.event;

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: BibItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: BibItem): Thenable<BibItem[]> {
		if (!vscode.window.activeTextEditor) {
			return Promise.resolve([]);
		}
		return Promise.resolve(this.getBibItems(element));
	}

    public navigate(bibItem: BibItem) {
        vscode.commands.executeCommand("revealLine", {"lineNumber": bibItem.line_start, "at": "top"});
    }

    public select(bibItem: BibItem) {
        if (vscode.window.activeTextEditor) {
            let bib_range = new vscode.Range(bibItem.line_start, 0, bibItem.line_end, 0);
            vscode.window.activeTextEditor.selection = new vscode.Selection(bib_range.start, bib_range.end);
        }
    }

    private getBibItems(item?: BibItem): BibItem[] {
        let count_leading_char = function(line: string,  char: string): number {
            let count = 0;
            for (; count < line.length && line[count] == char; count++);
            return count;
        }
        let count_char = function(line: string,  char: string): number {
            let count = 0;
            for (var i = 0; i < line.length; i++) {
                if (line[i] == char) count += 1;
            }
            return count;
        }
        let extract_parentheses = function(s: string, left: string = "{", right: string = "}"): string {
            let left_count = 0;
            let right_count = 0;
            let i = 0;
            while (i < s.length) {
                if (left_count > 0 && left_count == right_count) return s.substring(0, i);

                if (s[i] == left) left_count += 1;
                else if (s[i] == right) right_count += 1;
                i += 1
            }
            return s;
        }


        console.log(item);
        let line_offset: number = 0;
        let level = 0;
        if (item) {
            if (item.level == 99) {
                return [];
            }
            else {
                level = item.level;
                line_offset = item.line_start + 1;
            }
        }
        let text: string = vscode.window.activeTextEditor?.document.getText() || "";
        let lines = text.split("\n");
        if (line_offset == lines.length) return [];
        let next_level_head = "#".repeat(level + 1);
        let bibItems = [];
        let i = line_offset;
        while(i < lines.length) {
            let line = lines[i];
            console.log("Current line", i, line);
            // Sub-header is met
            if (line.startsWith(next_level_head)) {
                let actual_level = count_leading_char(line, "#");
                let line_start = i;
                let header = line.substring(count_leading_char(line, "#")).trim();
                line = "";  // Insert a virtual line for convenience
                // end with #= or find a equal or higher level label, then stop
                while (!line.startsWith("#") || (line.startsWith("#") && count_leading_char(line, "#") > actual_level)) {
                    i += 1
                    if (i == lines.length) break;
                    line = lines[i]
                }
                bibItems.push(new BibItem(
                    header, "", actual_level, line_start, i, vscode.TreeItemCollapsibleState.Expanded
                ));
            }
			else if (line.startsWith("@")) {
			    // 抓 key（条目标签）
			    let matches = line.match(/{[^,]*,/); // 仅到第一个逗号，避免贪婪
			    if (matches == null) {
			        i += 1;
			        if (i == lines.length) break;
			        continue;
			    }
			    let label = matches[0];
			    label = label.substring(1, label.length - 1); // 去掉包围的 '{' 与最后的逗号
			
			    // 统计花括号直到配平（单行/多行通吃）
			    const countChar = (s: string, ch: string) =>
			        (s.match(new RegExp(`\\${ch}`, "g")) || []).length;
			
			    const braceDelta = (s: string) => countChar(s, "{") - countChar(s, "}");
			
			    let bib_start_line = i;
			    let balance = braceDelta(line);
			    while (balance > 0) {
			        i += 1;
			        if (i == lines.length) return bibItems; // 非配平，提前返回
			        line = lines[i];
			        balance += braceDelta(line);
			    }
			    let bib_end_line = i;
			
			    // 关键修复：包含当前行；并保留换行，正则更稳
			    let total_bibtext = lines.slice(bib_start_line, bib_end_line + 1).join("\n");
			
			    // 解析 title，优先 title，其次回退 booktitle；兼容 {...} / "..." / 裸值
			    const matchField = (key: string, txt: string): string | null => {
			        // (^|[,\s]) 确保是独立键；值可为 {…} 或 "…" 或到下一个逗号/右花括号
			        const re = new RegExp(
			            `(?:^|[\\s,])${key}\\s*=\\s*(` +
			                `{[^{}]*}` +              // 花括号
			                `|"[^"]*"` +              // 双引号
			                `|[^,}\\n]+` +            // 裸值（直到逗号/右花括号/换行）
			            `)`,
			            "i"
			        );
			        const m = txt.match(re);
			        if (!m) return null;
			        let val = m[1].trim();
			        if ((val.startsWith("{") && val.endsWith("}")) ||
			            (val.startsWith("\"") && val.endsWith("\""))) {
			            val = val.slice(1, -1);
			        }
			        // 压一压空白
			        return val.replace(/[\s\t\n]+/g, " ").trim();
			    };
			
			    let title = matchField("title", total_bibtext) ?? matchField("booktitle", total_bibtext) ?? "";
			
			    // 推入 TreeItem
			    bibItems.push(new BibItem(
			        label,
			        title,
			        99,
			        bib_start_line,
			        bib_end_line + 1, // 选区 end 行用下一行开头，方便高亮
			        vscode.TreeItemCollapsibleState.None
			    ));
			
			    i += 1;
			    if (i == lines.length) return bibItems;
			}

            // if met a higher-level label, then quit.
            else if (line.startsWith("#") && count_leading_char(line, "#") <= level + 1) break;
            else {
                i += 1;
                if (i == lines.length) break;
            }
        }
        console.log("Finished", item);
        return bibItems;

    }

}
