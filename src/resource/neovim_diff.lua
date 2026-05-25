-- neovim_diff.lua (thin wrapper)
-- Called via nvim_exec_lua from pi-claudify's requestNeovimDiffEditApproval().
--
-- Parameters (passed as varargs via nvim_exec_lua):
--   left_path    (string)  Path to the original file.
--   right_path   (string)  Path to the temp file with new content.
--   http_socket  (string)  Unix socket path of the pi-claudify HTTP server.
--   nonce        (string)  Unique ID for this request, included in the POST body.
--   http_url     (string)  Full URL to POST the decision to.
local left_path, right_path, http_socket, nonce, http_url = ...

local neovim_diff = require("u/aux/neovim_diff")

local function post_result(decision, reason)
    local body = vim.json.encode({
        nonce = nonce,
        decision = decision,
        reason = reason,
    })
    -- Do not pass the JSON body as a command-line argument.  Long UTF-8
    -- reject reasons (for example Chinese text) can make jobstart/system hit
    -- argv length/encoding edge cases and surface as a Neovim error.  Stream
    -- the body through stdin instead.
    local ok, output = pcall(vim.fn.system, {
        'curl', '--unix-socket', http_socket,
        '-sS', '-X', 'POST',
        http_url,
        '-H', 'Content-Type: application/json',
        '--data-binary', '@-',
    }, body)
    if not ok then
        vim.notify('[pi-claudify] failed to post edit approval result: ' .. tostring(output), vim.log.levels.ERROR)
    elseif vim.v.shell_error ~= 0 then
        vim.notify('[pi-claudify] failed to post edit approval result: ' .. tostring(output), vim.log.levels.ERROR)
    end
end

local mode = vim.api.nvim_get_mode().mode
local focus_new_tab = mode == 'n' or mode == 'nt' or mode == 't'

neovim_diff({
    left_path = left_path,
    right_path = right_path,
    focus_new_tab = focus_new_tab,
    callback = function(result)
        if result.action == "accept" then
            post_result("accept")
        else
            post_result("reject", result.reason)
        end
    end,
})
