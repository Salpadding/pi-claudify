-- Refresh loaded Neovim buffers for a file after pi-claudify writes it on disk.
-- Parameters:
--   file_path (string) Path to the file that was written.
local file_path = ...
local abs_path = vim.fn.fnamemodify(file_path, ':p')

for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf)
        and vim.api.nvim_buf_get_name(buf) == abs_path then
        pcall(function()
            vim.api.nvim_buf_call(buf, function()
                vim.cmd('edit!')
            end)
        end)
    end
end
