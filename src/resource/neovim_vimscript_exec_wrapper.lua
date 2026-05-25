local source = ...
local ok, result = pcall(function()
    return vim.api.nvim_exec2(source, { output = true })
end)
if ok then
    return { ok = true, result = result }
end
return { ok = false, error = tostring(result) }
