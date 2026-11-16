// Success envelope for every planner route: { success: true, ...body }.
export const ok = (res, body = {}, status = 200) => res.status(status).json({ success: true, ...body });
