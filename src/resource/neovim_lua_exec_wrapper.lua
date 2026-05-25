local source = ...
local loader = loadstring or load
local fn, load_error = loader(source)
if not fn then
    return { ok = false, error = tostring(load_error) }
end
local ok, result = pcall(fn)
if ok then
    return { ok = true, result = result }
end
return { ok = false, error = tostring(result) }
