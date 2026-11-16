"""ZLens launcher: the page Snowsight's Launch app opens.

ZLens stops itself after 60 idle minutes, and a start takes about 2 to 3 minutes. Opening its
address while it is stopped or starting shows Snowflake's raw "service is not yet running" page,
and each reload asks for sign-in again. This page starts ZLens when it has stopped, waits until
Snowflake reports it READY, and only then offers Open ZLens and its address.

A page left open goes stale: Snowsight puts it to sleep, and reopening it can first show Snowsight's
cached copy. So every state says when it was checked (in the Snowflake session's time zone, with the
zone), and once ZLens is ready the page checks again every minute for 10 minutes, so a ZLens that
stops or restarts shows as it is (a stopped one is started again). Then it stops checking, so its
warehouse can suspend, and offers Check again. A start that never finishes stops being checked too.

It reads no customer data and calls nothing outside Snowflake: only the app's own procedures
app_public.launcher_status() and app_public.launcher_start(), and the app's name and the time.
"""

import datetime
import json
import os
import time

import streamlit as st
from snowflake.snowpark.context import get_active_session

POLL_SECONDS = 5
TYPICAL_START_SECONDS = 180
SLOW_START_SECONDS = 300
RESEND_START_SECONDS = 30
# A start that has not finished after 20 minutes is no longer checked by itself.
STOP_WAITING_SECONDS = 1200
# Once ZLens is ready: check again every minute, for 10 minutes, then stop.
RECHECK_SECONDS = 60
RECHECK_FOR_SECONDS = 600
# The ZLens mark, uploaded with this page (the launcher folder of the app package).
LOGO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "zlens-logo.png")

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
    """The app's name and the time of this check, in the Snowflake session's time zone (one query)."""
    try:
        row = session.sql("SELECT CURRENT_DATABASE(), CURRENT_TIMESTAMP()").collect()[0]
        return str(row[0] or ""), row[1]
    except Exception:  # noqa: BLE001 - the page still works; the time then comes from this runtime
        return "", None


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
        with open(LOGO, "rb") as image:
            st.image(image.read(), width=56)
    except Exception:  # noqa: BLE001 - a missing or unreadable logo never stops the page
        pass
    st.title("ZLens")


state = st.session_state
status = read_status()
name = status["status"]
app, moment = read_context()
app = app or "<this app>"
warehouse = f"{app}_WH"
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

# Not set up yet: the free app serves one named Snowflake user.
if not status["zlens_user"]:
    st.subheader("Set up ZLens first")
    st.write(
        "An admin names the one Snowflake user who uses ZLens, grants it one database, "
        "and grants it Cortex for Ask. Run these as a role that owns the app (replace the names):"
    )
    st.code(
        f"ALTER APPLICATION {app} SET CONFIGURATION ZLENS_USER VALUE = 'THEIR_USER';\n"
        f"GRANT USAGE ON DATABASE MY_DB TO APPLICATION {app};\n"
        f"GRANT USAGE ON SCHEMA MY_DB.MY_SCHEMA TO APPLICATION {app};\n"
        f"GRANT SELECT ON ALL TABLES IN SCHEMA MY_DB.MY_SCHEMA TO APPLICATION {app};\n"
        f"GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION {app};",
        language="sql",
    )
    st.caption("The app's README has the same steps. Then open this page again.")
    st.caption(
        f"If Snowsight asks you to select a warehouse before this page opens, pick {warehouse}, "
        "the app's own warehouse: this page runs on it."
    )
    st.stop()

# Someone else: ZLens would refuse them after the start, so say so first.
signed_in = viewer()
if signed_in and signed_in.upper() != status["zlens_user"].upper():
    st.warning(
        f"ZLens serves {status['zlens_user']}, and you are signed in as {signed_in}. "
        "An admin can name you on the app's Configurations tab."
    )
    st.stop()

if name == "READY" and status["url"]:
    if "ready_since" not in state:
        state["ready_since"] = now
        if "started_at" in state and "started_in" not in state:
            state["started_in"] = minutes(now - state["started_at"])
    st.success(f"ZLens is ready. Checked at {checked}.")
    if "started_in" in state:
        st.caption(f"Started in {state['started_in']}.")
    st.link_button("Open ZLens", status["url"], type="primary")
    st.caption(
        "Opens in a new tab, where Snowflake asks you to sign in once. "
        "If your browser blocks it, copy the address:"
    )
    st.code(status["url"], language=None)
    st.caption(
        f"ZLens serves {status['zlens_user']}. You can close this tab once ZLens is open: "
        f"while it stays open it keeps the app's warehouse, {warehouse}, running. "
        "ZLens stops by itself after 60 idle minutes; Launch app starts it again."
    )
    left = RECHECK_FOR_SECONDS - (now - state["ready_since"])
    if left > 0:
        st.caption(f"This page checks again every minute until {clock(moment, left)}.")
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
if name == "SUSPENDING":
    st.info("ZLens is stopping. This page starts it again as soon as it has stopped.")
else:
    st.info("Starting ZLens, about 2 to 3 minutes.")
st.progress(min(elapsed / TYPICAL_START_SECONDS, 0.95))
st.caption(f"{minutes(elapsed)} so far. Your projects are kept. Checked at {checked}.")
if elapsed > STOP_WAITING_SECONDS:
    st.warning(
        "ZLens has not started after 20 minutes, so this page has stopped checking. "
        "An admin can run CALL app_public.start_app() to try again."
    )
    if st.button("Check again"):
        state["started_at"] = time.time()
        st.rerun()
    st.stop()
if elapsed > SLOW_START_SECONDS:
    st.warning("Still starting after 5 minutes. Keep this page open, or try again in a few minutes.")
time.sleep(POLL_SECONDS)
st.rerun()
