-- ---------------------------------------------------------------------------
-- ScratchBuffer: a temporary buffer backed by a file on disk
-- ---------------------------------------------------------------------------
local ScratchBuffer = {}
ScratchBuffer.__index = ScratchBuffer

function ScratchBuffer:new(file_path)
    local obj = setmetatable({}, ScratchBuffer)
    obj.file_path = vim.fn.fnamemodify(file_path, ':p')
    obj.display_path = vim.fn.fnamemodify(file_path, ':.')
    obj.buf = vim.api.nvim_create_buf(false, true)
    obj.autocmd_inited = false
    vim.api.nvim_buf_set_name(obj.buf, 'diff://' .. obj.display_path)

    obj:_load_lines()

    local ft = vim.filetype.match({ filename = file_path }) or ''
    vim.bo[obj.buf].filetype = ft
    vim.bo[obj.buf].buftype = 'acwrite'
    vim.bo[obj.buf].bufhidden = 'hide'
    vim.bo[obj.buf].swapfile = false
    vim.bo[obj.buf].modifiable = true
    vim.bo[obj.buf].readonly = false

    return obj
end

function ScratchBuffer:_read_file()
    if vim.fn.filereadable(self.file_path) == 1 then
        return vim.fn.readfile(self.file_path, 'b')
    end
    return {}
end

function ScratchBuffer:_load_lines()
    vim.api.nvim_buf_set_lines(self.buf, 0, -1, false, self:_read_file())
end

function ScratchBuffer:reload()
    self:_load_lines()
end

function ScratchBuffer:get_lines()
    return vim.api.nvim_buf_get_lines(self.buf, 0, -1, false)
end

function ScratchBuffer:destroy()
    pcall(vim.api.nvim_buf_delete, self.buf, { force = true })
end

-- ---------------------------------------------------------------------------
-- DiffRequest: a pair of scratch buffers representing one diff
-- ---------------------------------------------------------------------------
local DiffRequest = {}
DiffRequest.__index = DiffRequest

function DiffRequest:new(left_path, right_path, callback)
    local obj = setmetatable({}, DiffRequest)
    obj.left = ScratchBuffer:new(left_path)
    obj.right = ScratchBuffer:new(right_path)
    obj.callback = callback
    return obj
end

function DiffRequest:reload()
    self.left:reload()
    self.right:reload()
end

function DiffRequest:invoke_callback(action, reason)
    if self.callback then
        self.callback({ action = action, reason = reason })
    end
end

function DiffRequest:write_right_to_left()
    vim.fn.writefile(self.right:get_lines(), self.left.file_path, 'b')
end

function DiffRequest:write_right_to_right()
    vim.fn.writefile(self.right:get_lines(), self.right.file_path, 'b')
end

function DiffRequest:destroy()
    self.left:destroy()
    self.right:destroy()
end

-- ---------------------------------------------------------------------------
-- BashwRequest: inherits DiffRequest; right side is refreshed via a bash command
-- ---------------------------------------------------------------------------
local BashwRequest = setmetatable({}, { __index = DiffRequest })
BashwRequest.__index = BashwRequest

function BashwRequest:new(script_path, callback)
    if vim.fn.executable('shfmt') == 1 then
        pcall(vim.fn.system, string.format('shfmt -w %s', vim.fn.shellescape(script_path)))
    end
    local obj = setmetatable({}, self)
    obj.left = ScratchBuffer:new(script_path)
    obj.right = obj.left
    vim.bo[obj.left.buf].filetype = 'bash'
    obj.callback = callback
    return obj
end

-- ---------------------------------------------------------------------------
-- DiffManager: singleton that owns the preview tab and all diff requests
-- ---------------------------------------------------------------------------
local DiffManager = {}
DiffManager.__index = DiffManager

local _instance = nil

function DiffManager:get()
    if not _instance then
        _instance = setmetatable({
            tab = nil,
            left_win = nil,
            right_win = nil,
            requests = {},
            active = nil,
            suppress_tab_closed_autocmd = false,
        }, DiffManager)
    end
    return _instance
end

-- ---- tab / window lifecycle ------------------------------------------------

function DiffManager:ensure_tab(focus)
    if self.tab and vim.api.nvim_tabpage_is_valid(self.tab) then
        return
    end
    local origin_tab = vim.api.nvim_get_current_tabpage()
    vim.cmd('tabnew')
    self.tab = vim.api.nvim_get_current_tabpage()
    local tabnr = vim.api.nvim_tabpage_get_number(self.tab)
    self.left_win = vim.api.nvim_get_current_win()
    vim.cmd('vsplit')
    self.right_win = vim.api.nvim_get_current_win()

    vim.api.nvim_create_autocmd('TabClosed', {
        callback = function(args)
            if tostring(tabnr) ~= args.match then return end
            if self.suppress_tab_closed_autocmd then return end
            self:on_tab_closed()
        end,
        once = true,
    })

    if not focus then
        vim.api.nvim_set_current_tabpage(origin_tab)
    end
end

function DiffManager:close_tab()
    self.suppress_tab_closed_autocmd = true
    pcall(function()
        if self.tab and vim.api.nvim_tabpage_is_valid(self.tab) then
            local tabnr = vim.api.nvim_tabpage_get_number(self.tab)
            vim.cmd(tabnr .. 'tabclose')
        end
    end)
    self.suppress_tab_closed_autocmd = false
    self.tab = nil
    self.left_win = nil
    self.right_win = nil
    self.active = nil
end

-- ---- diff on/off -----------------------------------------------------------

function DiffManager:diffoff()
    for _, win in ipairs({ self.left_win, self.right_win }) do
        pcall(function()
            if win and vim.api.nvim_win_is_valid(win) then
                vim.api.nvim_win_call(win, function() vim.cmd('diffoff') end)
            end
        end)
    end
end

function DiffManager:diffon()
    vim.api.nvim_win_call(self.left_win, function() vim.cmd('diffthis') end)
    vim.api.nvim_win_call(self.right_win, function() vim.cmd('diffthis') end)
end

-- ---- request list helpers --------------------------------------------------

function DiffManager:index_of(req)
    for i, r in ipairs(self.requests) do
        if r == req then return i end
    end
    return nil
end

function DiffManager:remove_request(req)
    local i = self:index_of(req)
    if i then table.remove(self.requests, i) end
end

-- ---- reload listed file buffers after accept -------------------------------

local function reload_file_buffers(file_path)
    local abs_path = vim.fn.fnamemodify(file_path, ':p')
    for _, buf in ipairs(vim.api.nvim_list_bufs()) do
        if vim.api.nvim_buf_is_loaded(buf) and vim.bo[buf].buflisted
            and vim.api.nvim_buf_get_name(buf) == abs_path then
            pcall(function()
                vim.api.nvim_buf_call(buf, function() vim.cmd('e!') end)
            end)
        end
    end
end

-- ---- bulk operations -------------------------------------------------------

function DiffManager:accept_request(req)
    -- Persist the accepted right-side buffer back to its backing preview file.
    -- pi-claudify passes this path as right_path and reads it after approval,
    -- then writes the final content to the real target file itself.
    req:write_right_to_right()
    req:invoke_callback("accept")
end

function DiffManager:reject_request(req, reason)
    req:invoke_callback("reject", reason)
end

function DiffManager:on_tab_closed()
    local remaining = self.requests
    self.requests = {}
    self.tab = nil
    self.left_win = nil
    self.right_win = nil
    self.active = nil

    for _, req in ipairs(remaining) do
        self:reject_request(req, '')
        req:destroy()
    end
end

function DiffManager:close_request(req)
    self:remove_request(req)
    self:diffoff()

    if #self.requests > 0 then
        self:show_request(self.requests[1])
    else
        self:close_tab()
    end

    req:destroy()
end

function DiffManager:accept_current()
    local req = self.active
    if not req then return end
    self:accept_request(req)
    self:close_request(req)
end

function DiffManager:reject_current()
    local req = self.active
    if not req then return end
    require("u.ask_input").ask_input("Reason(Optional)", function(reason)
        if reason == nil then return end
        self:reject_request(req, reason)
        self:close_request(req)
    end)
end

function DiffManager:_finish_all(remaining)
    self.requests = {}
    self:close_tab()
    for _, req in ipairs(remaining) do
        req:destroy()
    end
end

function DiffManager:_collect_all_starting_with(req)
    local list = { req }
    for _, r in ipairs(self.requests) do
        if r ~= req then list[#list + 1] = r end
    end
    return list
end

function DiffManager:accept_all()
    local req = self.active
    if not req then return end
    local all = self:_collect_all_starting_with(req)
    for _, r in ipairs(all) do
        self:accept_request(r)
    end
    self:_finish_all(all)
end

function DiffManager:reject_all()
    local req = self.active
    if not req then return end
    require("u.ask_input").ask_input("Reason(Optional)", function(reason)
        if reason == nil then return end
        local all = self:_collect_all_starting_with(req)
        for _, r in ipairs(all) do
            self:reject_request(r, reason)
        end
        self:_finish_all(all)
    end)
end

function DiffManager:refresh_all()
    for _, req in ipairs(self.requests) do
        req:reload()
    end
    vim.cmd('diffupdate')
end

-- ---- navigation ------------------------------------------------------------

function DiffManager:show_next(index)
    if not index then
        local cur = self:index_of(self.active)
        index = cur and (cur % #self.requests) + 1 or 1
    end
    local req = self.requests[index]
    if req and req ~= self.active then
        self:diffoff()
        self:show_request(req)
    end
end

-- ---- display a single request ----------------------------------------------

function DiffManager:set_statusline(req)
    local idx = self:index_of(req) or 0
    local is_bash = getmetatable(req) == BashwRequest
    local tabline = is_bash and "[Bash]" or "[Edit]"
    local title = is_bash and "[Bash]" or ("[Edit] " .. req.left.display_path)
    local status = string.format('[Process (%d/%d)] %s Press ? for help', idx, #self.requests, title)
    vim.b[req.left.buf].lualine_file_component = status
    vim.b[req.right.buf].lualine_file_component = status
    vim.b[req.left.buf].lua_tabline = tabline
    vim.b[req.right.buf].lua_tabline = tabline
end

function DiffManager:show_request(req)
    self.active = req

    vim.api.nvim_win_set_buf(self.left_win, req.left.buf)
    vim.api.nvim_win_set_buf(self.right_win, req.right.buf)

    self:set_statusline(req)
    if getmetatable(req) ~= BashwRequest then
        self:diffon()
    end

    local map_opts = { nowait = true, silent = true }
    for _, sb in ipairs({ req.left, req.right }) do
        local buf = sb.buf
        if not sb.autocmd_inited then
            sb.autocmd_inited = true
        else
            goto continue
        end
        vim.keymap.set('n', '?', function() self:show_help_menu() end,
            vim.tbl_extend('force', map_opts, { buffer = buf, desc = 'Diff actions menu' }))
        vim.keymap.set('n', '<Tab>', function() self:show_next() end,
            vim.tbl_extend('force', map_opts, { buffer = buf, desc = 'Show next diff' }))


        -- :w to accept current, :w! to accept all
        vim.api.nvim_create_autocmd('BufWriteCmd', {
            buffer = buf,
            callback = function()
                if vim.fn.histget(':', -1):find('!', 1, true) then
                    self:accept_all()
                else
                    self:accept_current()
                end
            end,
        })

        -- :e to reload current, :e! to reload all
        vim.api.nvim_create_autocmd('BufReadCmd', {
            buffer = buf,
            callback = function()
                if vim.fn.histget(':', -1):find('!', 1, true) then
                    self:refresh_all()
                else
                    self.active:reload()
                    vim.cmd('diffupdate')
                end
            end,
        })
        ::continue::
    end
end

-- ---- help menu -------------------------------------------------------------

function DiffManager:show_help_menu()
    local Menu = require("nui.menu")

    local actions = {
        { label = "y  Yes         (accept)",           key = "y", fn = function() self:accept_current() end },
        { label = "Y  Accept All  (accept remaining)", key = "Y", fn = function() self:accept_all() end },
        { label = "n  No          (reject)",           key = "n", fn = function() self:reject_current() end },
        { label = "N  Reject All  (reject remaining)", key = "N", fn = function() self:reject_all() end },
        {
            label = "r  Refresh     (reload from disk)",
            key = "r",
            fn = function()
                self.active:reload(); vim.cmd('diffupdate')
            end
        },
        { label = "R  Refresh All (reload all from disk)", key = "R", fn = function() self:refresh_all() end },
    }

    local action_map = {}
    local lines = {}
    for _, a in ipairs(actions) do
        lines[#lines + 1] = Menu.item(a.label, { key = a.key })
        action_map[a.key] = a.fn
    end

    local menu = Menu({
        relative = "editor",
        position = "50%",
        size = { width = 40, height = #actions },
        border = {
            style = "rounded",
            text = { top = " Diff Actions ", top_align = "center" },
        },
        win_options = {
            winhighlight = "Normal:Normal,FloatBorder:FloatBorder",
        },
        keymap = {
            focus_next = { "j", "<Down>" },
            focus_prev = { "k", "<Up>" },
            close = { "<Esc>", "<C-c>", "q", "?" },
            submit = { "<CR>" },
        },
    }, {
        lines = lines,
        on_submit = function(item) action_map[item.key]() end,
    })

    -- direct key shortcuts
    for key, fn in pairs(action_map) do
        menu:map("n", key, function()
            menu:unmount()
            fn()
        end, { nowait = true })
    end

    menu:mount()
end

-- ---------------------------------------------------------------------------
-- Module entry point
-- ---------------------------------------------------------------------------
return function(opts)
    local mgr = DiffManager:get()

    mgr:ensure_tab(opts.focus_new_tab)
    local req = nil

    if not opts.type or opts.type == "diff" then
        req = DiffRequest:new(opts.left_path, opts.right_path, opts.callback)
    else
        req = BashwRequest:new(opts.script_path, opts.callback)
    end
    mgr.requests[#mgr.requests + 1] = req
    local tag = getmetatable(req) == BashwRequest and '[Bash]' or '[Edit]'
    local msg = string.format('%s (%d/%d) %s', tag, #mgr.requests,
        #mgr.requests, req.left.display_path)
    vim.notify(msg, vim.log.levels.INFO)
    mgr:show_next(#mgr.requests)
end
