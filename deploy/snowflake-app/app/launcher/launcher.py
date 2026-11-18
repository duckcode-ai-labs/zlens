"""ZLens launcher: the page Snowsight's Launch app opens.

ZLens stops itself after 60 idle minutes. A start usually takes 2 to 3 minutes, and up to 20
minutes the first time after an install or update (likely Snowflake fetching the new image; in
our tests, first starts after an update took 14 and 15 minutes). Opening its address while it is stopped or
starting shows Snowflake's raw "service is not yet running" page, and each reload asks for sign-in
again. This page starts ZLens when it has stopped, waits until Snowflake reports it READY, and only
then offers Open ZLens and its address.

A page left open goes stale: Snowsight puts it to sleep, and reopening it can first show Snowsight's
cached copy. So every state says when it was checked (in the Snowflake session's time zone, with the
zone), and once ZLens is ready the page checks again every minute for 10 minutes, so a ZLens that
stops or restarts shows as it is (a stopped one is started again). Then it stops checking, so its
warehouse can suspend, and offers Check again. A start that never finishes stops being checked too.

Once the user is saved, the page also says when ZLens can read none of the account's data yet, with the grant
lines, and which databases it can read once one is granted (V17 p8 tester: one press of Run ran 1 of the 8
grant lines, and the page said "ZLens is ready" with no data granted).

It reads no customer data and calls nothing outside Snowflake: only the app's own procedures
app_public.launcher_status(), app_public.launcher_data() (database names, never rows) and
app_public.launcher_start(), and the app's name, the time and the warehouse this page runs on.
"""

import datetime
import json
import time

import streamlit as st
from snowflake.snowpark.context import get_active_session

POLL_SECONDS = 5
TYPICAL_START_SECONDS = 180
SLOW_START_SECONDS = 300
RESEND_START_SECONDS = 30
# A start that has not finished after 30 minutes is no longer checked by itself.
STOP_WAITING_SECONDS = 1800
# Once ZLens is ready: check again every minute, for 10 minutes, then stop.
RECHECK_SECONDS = 60
RECHECK_FOR_SECONDS = 600
# Before the user is saved: check every 10 seconds, for 10 minutes, so the page moves on by itself once the
# admin saves it (V17 p6 tester: after the save, Launch app kept showing the old "Set up ZLens first" until a
# browser reload; the page had stopped and Snowsight showed its last frame).
SETUP_RECHECK_SECONDS = 10
SETUP_RECHECK_FOR_SECONDS = 600
# Streamlit removes the lines of an earlier screen only when a run ends, and a page that checks again ends each
# run with a rerun: a faded line of the set-up screen stayed under "ZLens is ready" for 10 minutes (V17 p8
# tester). Empty slots written after the current screen replace whatever an earlier, longer screen left there.
LEFTOVER_SLOTS = 16
# The ZLens mark (paper Z and the green certified dot on a dark tile), drawn inline. An image file
# shown with st.image does not load in a Native App's Streamlit page (V16 release check: a broken
# image), so the mark is SVG markup in the page itself, with nothing to fetch.
LOGO_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="56" height="56" '
    'role="img" aria-label="ZLens">'
    '<rect width="64" height="64" rx="14" fill="#0F1216"/>'
    '<g transform="translate(9 9) scale(0.7)">'
    '<path d="M11 12H51V20L24 44H37V52H11V44L38 20H11Z" fill="#EEF0EA"/>'
    '<circle cx="47.9" cy="48" r="6.4" fill="#2FD8A0"/></g></svg>'
)

st.set_page_config(page_title="ZLens", layout="centered")
session = get_active_session()


def read_status():
    """Service state, address and the configured ZLens user, from launcher_status()."""
    try:
        raw = session.sql("CALL app_public.launcher_status()").collect()[0][0]
        value = json.loads(raw) if isinstance(raw, str) else dict(raw or {})
    except Exception as error:  # noqa: BLE001 - shown to the person as is
        return {"status": "", "url": "", "zlens_user": "", "error": str(error)}
    return {
        "status": str(value.get("status") or "").upper(),
        "url": str(value.get("url") or ""),
        "zlens_user": str(value.get("zlens_user") or ""),
        "error": "",
    }


def read_context():
    """The app's name and the time of this check, in the Snowflake session's time zone.

    One query, as V16 had it. V17 added CURRENT_WAREHOUSE() to it, and in the installed app the whole query
    failed: the page then named the app "<this app>" and told the time in UTC (V17 and V17 p6 testers). The
    warehouse is read on its own (page_warehouse), so a failure there costs only the warehouse's name.
    """
    try:
        row = session.sql("SELECT CURRENT_DATABASE(), CURRENT_TIMESTAMP()").collect()[0]
        return str(row[0] or ""), row[1]
    except Exception:  # noqa: BLE001 - the page still works; the time then comes from this runtime
        return "", None


def page_warehouse_name():
    """The warehouse this page runs on, read once per page session; empty when Snowflake does not say.

    The query history of the V17 test showed the page running on the app's <app>_WH (its QUERY_WAREHOUSE),
    whichever warehouse the person picked in Snowsight's prompt. The page names that one when this read fails.
    """
    if "page_warehouse" not in st.session_state:
        try:
            st.session_state["page_warehouse"] = str(session.sql("SELECT CURRENT_WAREHOUSE()").collect()[0][0] or "")
        except Exception:  # noqa: BLE001 - only the warehouse's name is lost
            st.session_state["page_warehouse"] = ""
    return st.session_state["page_warehouse"]


def read_data():
    """The databases ZLens can read (names only), from launcher_data(); None when the app cannot tell.

    Read until one is found, then kept for this page session: a grant does not go away while the page is open,
    and each read is a few SHOW commands.
    """
    if st.session_state.get("data"):
        return st.session_state["data"]
    try:
        raw = session.sql("CALL app_public.launcher_data()").collect()[0][0]
        value = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:  # noqa: BLE001 - the page then says nothing about data
        return None
    if not isinstance(value, list):
        return None
    names = [str(name) for name in value if name]
    if names:
        st.session_state["data"] = names
    return names


def grant_lines(app):
    """The grants of the README's steps 2 and 4, with the app's name filled in."""
    return (
        f"GRANT USAGE ON DATABASE MY_DB TO APPLICATION {app};\n"
        f"GRANT USAGE ON SCHEMA MY_DB.MY_SCHEMA TO APPLICATION {app};\n"
        f"GRANT SELECT ON ALL TABLES IN SCHEMA MY_DB.MY_SCHEMA TO APPLICATION {app};\n"
        f"GRANT SELECT ON ALL VIEWS IN SCHEMA MY_DB.MY_SCHEMA TO APPLICATION {app};\n"
        f"GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION {app};"
    )


RUN_ALL = "Select all the lines, then press Run: Snowsight's Run on its own runs only the statement at the cursor."


def show_missing_data(app):
    """The grant step, while ZLens can read none of the account's data."""
    st.warning(
        "**One step is missing: grant ZLens a database.** ZLens can read none of your data yet. Run these as "
        "a role that owns the app, with your database and schema names. " + RUN_ALL
    )
    st.code(grant_lines(app), language="sql")


def clear_leftovers():
    """Empty slots after this screen's lines, so nothing of an earlier screen stays faded under it."""
    for _ in range(LEFTOVER_SLOTS):
        st.empty()


def start():
    try:
        session.sql("CALL app_public.launcher_start()").collect()
    except Exception:  # noqa: BLE001 - the next status read says what happened
        pass


def viewer():
    """The signed-in Snowflake user, when Streamlit can tell; empty otherwise."""
    for attribute in ("user", "experimental_user"):
        try:
            info = getattr(st, attribute)
            for key in ("user_name", "login_name"):
                name = info.get(key) if hasattr(info, "get") else None
                if name:
                    return str(name)
        except Exception:  # noqa: BLE001 - older or restricted Streamlit
            continue
    return ""


def minutes(seconds):
    seconds = int(max(0, seconds))
    return f"{seconds // 60}:{seconds % 60:02d}"


def clock(moment, later_seconds=0):
    """A time with its zone, "16:38 PST", so a page left open shows how old it is.

    moment is CURRENT_TIMESTAMP() from Snowflake, in the session's time zone. Without it, this
    runtime's own clock in UTC.
    """
    if not isinstance(moment, datetime.datetime) or moment.tzinfo is None:
        moment = datetime.datetime.now(datetime.timezone.utc)
    moment = moment + datetime.timedelta(seconds=max(0, later_seconds))
    zone = moment.tzname() or ""
    if not zone or zone[0] in "+-" or zone[0].isdigit():
        offset = int((moment.utcoffset() or datetime.timedelta(0)).total_seconds() // 60)
        hours, mins = divmod(abs(offset), 60)
        zone = "UTC" if offset == 0 else f"UTC{'+' if offset > 0 else '-'}{hours:02d}:{mins:02d}"
    return f"{moment:%H:%M} {zone}"


def show_title():
    """The ZLens mark above the page's title. The page works without it."""
    try:
        st.markdown(LOGO_SVG, unsafe_allow_html=True)
    except Exception:  # noqa: BLE001 - a missing or unreadable logo never stops the page
        pass
    st.title("ZLens")


state = st.session_state
status = read_status()
name = status["status"]
app, moment = read_context()
app = app or "<this app>"
warehouse = f"{app}_WH"
page_warehouse = page_warehouse_name() or (warehouse if app != "<this app>" else "")
checked = clock(moment)
now = time.time()

# ZLens stopped or restarted since the last check: that is a new start, timed from now.
if name != "READY":
    state.pop("ready_since", None)
    if state.get("last_status") == "READY":
        state["started_at"] = now
        state.pop("start_sent_at", None)
        state.pop("started_in", None)
state["last_status"] = name

show_title()

if status["error"]:
    st.error("ZLens could not read its own state: " + status["error"])
    st.caption(f"Checked at {checked}.")
    if st.button("Try again"):
        st.rerun()
    st.stop()

# Not set up yet: the free app serves one named Snowflake user. The page says the step that is missing, and
# checks again by itself, so it moves on once the admin saves the user (V17 p6 tester).
if not status["zlens_user"]:
    state.setdefault("setup_since", now)
    st.subheader("Set up ZLens first")
    st.write(
        "**One step is missing: name the Snowflake user who uses ZLens.** On the app's **Configurations** tab, "
        "set **Snowflake user who uses ZLens** and press **Save**. When it is saved, the tab shows a green "
        "**Configured** badge with the name; if it still shows **Review**, open Review and Save again. "
        "Or run this as a role that owns the app:"
    )
    st.code(f"ALTER APPLICATION {app} SET CONFIGURATION ZLENS_USER VALUE = 'THEIR_USER';", language="sql")
    st.write(
        "If you have not yet granted it a database and Cortex (the README's steps 2 to 4), run these too, "
        "with your database and schema names. " + RUN_ALL
    )
    st.code(grant_lines(app), language="sql")
    st.caption(
        f"If Snowsight asks you to select a warehouse before this page opens, pick {warehouse}, "
        "the app's own warehouse: this page runs on it."
    )
    left = SETUP_RECHECK_FOR_SECONDS - (now - state["setup_since"])
    if left > 0:
        st.caption(
            f"Checked at {checked}. This page checks again every 10 seconds until {clock(moment, left)}, "
            "and moves on by itself once the user is saved."
        )
        clear_leftovers()
        time.sleep(SETUP_RECHECK_SECONDS)
        st.rerun()
    st.caption(f"Checked at {checked}. This page has stopped checking, so its warehouse can suspend.")
    if st.button("Check again"):
        state["setup_since"] = time.time()
        st.rerun()
    st.stop()
state.pop("setup_since", None)

# Someone else: ZLens would refuse them after the start, so say so first.
signed_in = viewer()
if signed_in and signed_in.upper() != status["zlens_user"].upper():
    st.warning(
        f"ZLens serves {status['zlens_user']}, and you are signed in as {signed_in}. "
        "An admin can name you on the app's Configurations tab."
    )
    st.stop()

# The user is saved: say so when ZLens can read none of the account's data yet (None: the app could not tell).
data = read_data()

if name == "READY" and status["url"]:
    if "ready_since" not in state:
        state["ready_since"] = now
        if "started_at" in state and "started_in" not in state:
            state["started_in"] = minutes(now - state["started_at"])
    if data == []:
        show_missing_data(app)
    st.success(f"ZLens is ready. Checked at {checked}.")
    if "started_in" in state:
        st.caption(f"Started in {state['started_in']}.")
    st.link_button("Open ZLens", status["url"], type="primary")
    st.caption(
        "Opens in a new tab, where Snowflake asks you to sign in once. "
        "If your browser blocks it, copy the address:"
    )
    st.code(status["url"], language=None)
    # Two warehouses: the page's own (read from Snowflake, else the app's <app>_WH, the page's QUERY_WAREHOUSE),
    # and the one Snowsight shows at the top of the page, which Snowsight's own calls for an open page use
    # (V17 p8 query history: the page's queries ran on ZLENS_FRESH_WH, Snowsight's on the user's warehouse).
    keeps = f"this page's own, {page_warehouse}" if page_warehouse else "this page's own"
    reads = f", and can read {', '.join(data)}" if data else ""
    st.caption(
        f"ZLens serves {status['zlens_user']}{reads}. You can close this tab once ZLens is open: "
        f"while it stays open it keeps two warehouses running: {keeps}, and the one Snowsight shows at the top of the page. "
        "ZLens stops by itself after 60 idle minutes; Launch app starts it again."
    )
    left = RECHECK_FOR_SECONDS - (now - state["ready_since"])
    if left > 0:
        st.caption(f"This page checks again every minute until {clock(moment, left)}.")
        clear_leftovers()
        time.sleep(RECHECK_SECONDS)
        st.rerun()
    st.caption("This page has stopped checking, so its warehouse can suspend.")
    if st.button("Check again"):
        state["ready_since"] = time.time()
        st.rerun()
    st.stop()

if name in ("FAILED", "INTERNAL_ERROR"):
    st.error(
        f"ZLens did not start (Snowflake reports {name}). "
        "An admin can run CALL app_public.start_app() to try again."
    )
    st.caption(f"Checked at {checked}.")
    if st.button("Check again"):
        st.rerun()
    st.stop()

# Stopped, stopping or starting: start it when it has stopped, then wait for READY.
state.setdefault("started_at", now)
if name == "SUSPENDED" and now - state.get("start_sent_at", 0) > RESEND_START_SECONDS:
    start()
    state["start_sent_at"] = now

elapsed = now - state["started_at"]
if data == []:
    show_missing_data(app)
if name == "SUSPENDING":
    st.info("ZLens is stopping. This page starts it again as soon as it has stopped.")
elif elapsed > SLOW_START_SECONDS:
    # Past the usual time, the page no longer promises it (V4 tester: the usual time stayed on
    # screen through a 14-minute start).
    st.info("Starting ZLens. The first start after an install or update can take up to 20 minutes.")
else:
    st.info("Starting ZLens. This usually takes 2 to 3 minutes, and up to 20 minutes the first time after an install or update.")
st.progress(min(elapsed / TYPICAL_START_SECONDS, 0.95))
st.caption(f"{minutes(elapsed)} so far. Your projects are kept. Checked at {checked}.")
if elapsed > STOP_WAITING_SECONDS:
    st.warning(
        "ZLens has not started after 30 minutes, so this page has stopped checking. "
        "An admin can run CALL app_public.start_app() to try again."
    )
    if st.button("Check again"):
        state["started_at"] = time.time()
        st.rerun()
    st.stop()
if elapsed > SLOW_START_SECONDS:
    st.warning("Still starting after 5 minutes. Keep this page open, or try again in a few minutes.")
clear_leftovers()
time.sleep(POLL_SECONDS)
st.rerun()
