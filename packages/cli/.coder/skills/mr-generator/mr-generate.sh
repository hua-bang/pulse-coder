#!/bin/bash

# MR Generator - 自动生成 MR 标题和描述
# 基于当前分支与远程 master 的 diff 分析

set -e

# 配置
TARGET_BRANCH="origin/master"
PREVIEW_MODE=false

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# 解析参数
while [[ $# -gt 0 ]]; do
    case $1 in
        --target)
            TARGET_BRANCH="$2"
            shift 2
            ;;
        --preview)
            PREVIEW_MODE=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [--target branch] [--preview]"
            echo "Generate MR title and description based on branch diff"
            echo ""
            echo "Options:"
            echo "  --target branch    Target branch to compare against (default: origin/master)"
            echo "  --preview         Show preview mode with additional info"
            echo "  -h, --help        Show this help message"
            exit 0
            ;;
        *)
            echo "❌ Unknown option: $1"
            exit 1
            ;;
    esac
done

# 获取当前分支
current_branch=$(git branch --show-current)
if [[ "$current_branch" == "master" || "$current_branch" == "main" ]]; then
    echo "❌ Cannot create MR from master branch"
    exit 1
fi

# 确保远程分支是最新的
echo -e "${BLUE}Fetching latest changes...${NC}"
git fetch origin

# 检查目标分支是否存在
if ! git ls-remote --heads origin "${TARGET_BRANCH#origin/}" | grep -q "refs/heads/"; then
    echo "❌ Target branch $TARGET_BRANCH does not exist"
    exit 1
fi

# 获取 diff 统计和变更类型
diff_stats=$(git diff --stat "$TARGET_BRANCH"...HEAD 2>/dev/null || echo "")
if [[ -z "$diff_stats" ]]; then
    echo "❌ No changes detected between $current_branch and $TARGET_BRANCH"
    exit 1
fi

# 获取变更文件列表和状态
changed_files=$(git diff --name-only "$TARGET_BRANCH"...HEAD)
file_count=$(echo "$changed_files" | wc -l | tr -d ' ')

# 获取文件状态统计
added_files=$(git diff --name-status "$TARGET_BRANCH"...HEAD | grep "^A" | wc -l | tr -d ' ')
modified_files=$(git diff --name-status "$TARGET_BRANCH"...HEAD | grep "^M" | wc -l | tr -d ' ')
deleted_files=$(git diff --name-status "$TARGET_BRANCH"...HEAD | grep "^D" | wc -l | tr -d ' ')

# 分析变更类型
analyze_change_type() {
    local files="$1"
    
    # 检查文件类型分布
    local has_src=$(echo "$files" | grep -c "src/" || echo 0)
    local has_test=$(echo "$files" | grep -c "test\|spec" || echo 0)
    local has_docs=$(echo "$files" | grep -c "\.md\|README\|docs/" || echo 0)
    local has_config=$(echo "$files" | grep -c "\.json\|\.yml\|\.yaml\|\.config" || echo 0)
    local has_fix=$(git log --oneline "$TARGET_BRANCH"...HEAD | grep -ic "fix\|bug\|repair\|resolve" || echo 0)
    local has_feature=$(git log --oneline "$TARGET_BRANCH"...HEAD | grep -ic "feat\|feature\|add\|implement" || echo 0)
    
    # 基于文件状态判断
    if [[ $added_files -gt 0 && $modified_files -eq 0 && $deleted_files -eq 0 ]]; then
        echo "add"
    elif [[ $deleted_files -gt 0 ]]; then
        echo "remove"
    elif [[ $has_fix -gt 0 ]]; then
        echo "fix"
    elif [[ $has_feature -gt 0 ]]; then
        echo "feature"
    elif [[ $has_test -gt $(($file_count / 2)) ]]; then
        echo "test"
    elif [[ $has_docs -gt $(($file_count / 2)) ]]; then
        echo "docs"
    elif [[ $has_config -gt 0 ]]; then
        echo "config"
    else
        echo "update"
    fi
}

# 提取主要模块
extract_main_module() {
    local files="$1"
    
    # 找出最常见的目录/模块
    local module=$(echo "$files" | sed 's|\(.*\)/.*|\1|' | sort | uniq -c | sort -nr | head -1 | awk '{print $2}' | sed 's|packages/cli/||' | sed 's|src/||' | sed 's|lib/||' | sed 's|components/||' | sed 's|pages/||' | sed 's|\.coder/skills/||')
    
    # 如果没有目录，从文件名提取
    if [[ -z "$module" || "$module" == "." ]]; then
        local first_file=$(echo "$files" | head -1 | sed 's|.*/||' | sed 's/\..*$//')
        module=$(echo "$first_file" | tr '_' ' ' | tr '-' ' ')
    fi
    
    # 转换为简洁描述
    echo "$module" | sed 's/$/ module/' | sed 's/src module/source/' | sed 's/config module/configuration/' | sed 's/test module/testing/' | sed 's/api/API/' | sed 's/ui/UI/' | sed 's/auth/authentication/' | sed 's/validation/validation/' | sed 's/utils/utilities/' | sed 's/services/service layer/' | sed 's/ [Mm]odule$//' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

# 生成标题
generate_title() {
    local change_type="$1"
    local module="$2"
    
    case "$change_type" in
        "add")
            echo "Add ${module}"
            ;;
        "remove")
            echo "Remove ${module}"
            ;;
        "fix")
            echo "Fix ${module} issue"
            ;;
        "test")
            echo "Add tests for ${module}"
            ;;
        "docs")
            echo "Update ${module} documentation"
            ;;
        "config")
            echo "Update ${module} configuration"
            ;;
        "feature")
            echo "Add ${module} functionality"
            ;;
        "update")
            echo "Update ${module}"
            ;;
        *)
            echo "Update ${module}"
            ;;
    esac
}

# 生成更智能的描述点
generate_description_points() {
    local change_type="$1"
    local files="$2"
    
    local points=()
    
    # 基于文件状态和类型生成描述
    local file_statuses=$(git diff --name-status "$TARGET_BRANCH"...HEAD)
    
    while IFS= read -r line; do
        local status=$(echo "$line" | awk '{print $1}')
        local file=$(echo "$line" | awk '{print $2}')
        local basename=$(basename "$file" | sed 's/\..*$//')
        local dirname=$(dirname "$file")
        
        case "$status" in
            "A")
                case "$file" in
                    *.sh)
                        points+=("Add ${basename} script for automation")
                        ;;
                    *.md|*.txt)
                        points+=("Add ${basename} documentation")
                        ;;
                    *.js|*.ts|*.py|*.go|*.java|*.cpp|*.c)
                        points+=("Implement ${basename} functionality")
                        ;;
                    *.json|*.yml|*.yaml|toml)
                        points+=("Add ${basename} configuration")
                        ;;
                    *.test.js|*.spec.js|*.test.ts|*.spec.ts)
                        points+=("Add test suite for ${basename%.*}")
                        ;;
                    *)
                        points+=("Add ${basename}")
                        ;;
                esac
                ;;
            "M")
                case "$file" in
                    *.js|*.ts|*.py|*.go)
                        if [[ "$change_type" == "fix" ]]; then
                            points+=("Fix ${basename} logic")
                        else
                            points+=("Improve ${basename} implementation")
                        fi
                        ;;
                    *.test.js|*.spec.js|*.test.ts|*.spec.ts)
                        points+=("Update tests for ${basename%.*}")
                        ;;
                    *.md|*.txt)
                        points+=("Update documentation")
                        ;;
                    *.json|*.yml|*.yaml)
                        points+=("Update configuration")
                        ;;
                    *.css|*.scss|*.less)
                        points+=("Improve styling")
                        ;;
                    *)
                        points+=("Update ${basename}")
                        ;;
                esac
                ;;
            "D")
                points+=("Remove ${basename}")
                ;;
        esac
    done <<< "$file_statuses"
    
    # 去重并保持顺序，最多3个点
    printf '%s\n' "${points[@]}" | awk '!seen[$0]++' | head -3
}

# 生成完整描述
generate_description() {
    local change_type="$1"
    local module="$2"
    local files="$3"
    
    local summary=""
    case "$change_type" in
        "add")
            summary="Add comprehensive ${module} functionality"
            ;;
        "remove")
            summary="Remove ${module} from codebase"
            ;;
        "fix")
            summary="Resolve ${module} issues and improve stability"
            ;;
        "test")
            summary="Enhance test coverage for ${module}"
            ;;
        "docs")
            summary="Improve ${module} documentation"
            ;;
        "config")
            summary="Update ${module} configuration"
            ;;
        "feature")
            summary="Implement ${module} functionality"
            ;;
        "update")
            summary="Update ${module} implementation"
            ;;
        *)
            summary="Update ${module}"
            ;;
    esac
    
    local points=$(generate_description_points "$change_type" "$files")
    
    echo "$summary"
    echo ""
    echo "$points" | sed 's/^/- /'
}

# 检查是否有 Jira ticket
get_jira_ticket() {
    local ticket=$(git log --oneline "$TARGET_BRANCH"...HEAD | grep -o "[A-Z][A-Z0-9]*-[0-9]*" | head -1 || echo "")
    echo "$ticket"
}

# 生成详细统计信息
generate_stats() {
    local files="$1"
    local total_lines=$(git diff --stat "$TARGET_BRANCH"...HEAD | tail -1 | awk '{print $1+$3}' || echo "0")
    
    echo "Files changed: $file_count"
    [[ $added_files -gt 0 ]] && echo "Files added: $added_files"
    [[ $modified_files -gt 0 ]] && echo "Files modified: $modified_files"
    [[ $deleted_files -gt 0 ]] && echo "Files deleted: $deleted_files"
    [[ $total_lines -gt 0 ]] && echo "Lines changed: ±$total_lines"
}

# 主逻辑
main() {
    echo -e "${BLUE}Analyzing changes between $current_branch and $TARGET_BRANCH...${NC}"
    
    # 分析变更
    change_type=$(analyze_change_type "$changed_files")
    main_module=$(extract_main_module "$changed_files")
    jira_ticket=$(get_jira_ticket)
    
    # 生成标题
    title=$(generate_title "$change_type" "$main_module")
    
    # 如果有 Jira ticket，添加到标题
    if [[ -n "$jira_ticket" ]]; then
        title="$jira_ticket: $title"
    fi
    
    # 截断标题到50字符以内
    if [[ ${#title} -gt 50 ]]; then
        title="${title:0:47}..."
    fi
    
    # 生成描述
    description=$(generate_description "$change_type" "$main_module" "$changed_files")
    
    # 输出结果
    if [[ "$PREVIEW_MODE" == true ]]; then
        echo -e "${GREEN}=== MR Preview ===${NC}"
        echo "Source: $current_branch"
        echo "Target: $TARGET_BRANCH"
        generate_stats "$changed_files"
        echo ""
    fi
    
    echo "$title"
    echo ""
    echo "$description"
}

# 运行主程序
main