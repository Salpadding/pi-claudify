-- Return real file buffers visible in the current Neovim tabpage.
-- The current window's buffer is listed first, followed by the other windows in
-- the current tab. Special buffers (terminal/help/prompt/etc.) and unnamed or
-- unreadable paths are ignored.

local tab = vim.api.nvim_get_current_tabpage()
local current_win = vim.api.nvim_get_current_win()
local wins = vim.api.nvim_tabpage_list_wins(tab)

table.sort(wins, function(a, b)
    if a == current_win then
        return true
    end
    if b == current_win then
        return false
    end
    return a < b
end)

local paths = {}
local seen = {}

for _, win in ipairs(wins) do
    if vim.api.nvim_win_is_valid(win) then
        local buf = vim.api.nvim_win_get_buf(win)
        if vim.api.nvim_buf_is_valid(buf) and vim.bo[buf].buftype == "" then
            local name = vim.api.nvim_buf_get_name(buf)
            if name ~= "" and vim.fn.filereadable(name) == 1 and not seen[name] then
                seen[name] = true
                table.insert(paths, name)
            end
        end
    end
end

return { paths = paths }
