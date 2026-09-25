@echo off
setlocal EnableDelayedExpansion

rem ===========================================================================
rem  Bubbler+ mock share
rem
rem  Builds a fake jobs tree in a folder called MockShare NEXT TO THIS SCRIPT,
rem  so the index rebuild has somewhere harmless to point. It only ever creates
rem  folders and empty .nc files, and it only ever writes inside the folder it
rem  makes - nothing outside MockShare is touched, read or deleted.
rem
rem    mockshare.bat          medium tree (default)
rem    mockshare.bat small    a few hundred folders, builds in seconds
rem    mockshare.bat large    closer to a real share, takes a while to build
rem    mockshare.bat clean    delete the tree and stop
rem
rem  There are deliberately NO .insp packages in here. A real one is a zip with
rem  a manifest inside, so a fake would only ever be skipped. The QC folders at
rem  the bottom of the summary are empty and waiting - save a package into one
rem  from the app to test the finding side as well as the walking side.
rem ===========================================================================

set "ROOTNAME=MockShare"
set "ROOT=%~dp0%ROOTNAME%"

rem ---- clean ----------------------------------------------------------------
if /i "%~1"=="clean" (
  if not exist "%ROOT%" (
    echo Nothing to clean - "%ROOT%" does not exist.
    goto :done
  )
  echo This will delete:
  echo     %ROOT%
  set /p "ANS=Delete it? [y/N] "
  if /i not "!ANS!"=="y" (
    echo Cancelled.
    goto :done
  )
  rd /s /q "%ROOT%"
  echo Deleted.
  goto :done
)

rem ---- size -----------------------------------------------------------------
rem CUSTOMERS  top-level folders
rem PARTS      part folders directly under each customer  (the ROOT\C\P\QC shape)
rem FAMILIES   family folders under each customer         (the ROOT\C\F\P\QC shape)
rem FAMPARTS   part folders inside each family
rem FILES      junk files per part folder - this is the number that used to hurt
set "SIZE=%~1"
if "%SIZE%"=="" set "SIZE=medium"

if /i "%SIZE%"=="small"  (set "CUSTOMERS=6"  & set "PARTS=8"  & set "FAMILIES=1" & set "FAMPARTS=4"  & set "FILES=5")
if /i "%SIZE%"=="medium" (set "CUSTOMERS=15" & set "PARTS=20" & set "FAMILIES=2" & set "FAMPARTS=8"  & set "FILES=12")
if /i "%SIZE%"=="large"  (set "CUSTOMERS=25" & set "PARTS=30" & set "FAMILIES=3" & set "FAMPARTS=12" & set "FILES=20")

if not defined CUSTOMERS (
  echo Unknown size "%SIZE%". Use small, medium, large, or clean.
  goto :done
)

rem ---- confirm --------------------------------------------------------------
if exist "%ROOT%" (
  echo A folder called %ROOTNAME% is already here:
  echo     %ROOT%
  set /p "ANS=Delete it and build a fresh one? [y/N] "
  if /i not "!ANS!"=="y" (
    echo Cancelled.
    goto :done
  )
  echo Removing the old one...
  rd /s /q "%ROOT%"
)

echo.
echo Building a %SIZE% mock share in:
echo     %ROOT%
echo.
md "%ROOT%" 2>nul

rem ---- the bulk of the tree -------------------------------------------------
rem None of these have a QC folder. That is the point: an empty share is the
rem slowest possible crawl, because nothing lets the walker stop early.
for /L %%c in (1,1,%CUSTOMERS%) do (
  set "N=0%%c"
  set "CUST=%ROOT%\Customer !N:~-2!"
  md "!CUST!" 2>nul

  for /L %%p in (1,1,%PARTS%) do call :mkpart "!CUST!\PN-!N:~-2!-%%p"

  for /L %%f in (1,1,%FAMILIES%) do (
    md "!CUST!\Family %%f" 2>nul
    for /L %%q in (1,1,%FAMPARTS%) do call :mkpart "!CUST!\Family %%f\PN-!N:~-2!F%%f-%%q"
  )
  echo   Customer !N:~-2! done
)

rem ---- the cases actually worth testing -------------------------------------
echo.
echo   Adding the edge cases...

rem 1  plain part folder, QC at depth 3 - the common shape
call :mkpart "%ROOT%\Customer 01\PN-01-01"
md "%ROOT%\Customer 01\PN-01-01\QC" 2>nul

rem 2  a QC with an Archive beside the live revisions
call :mkpart "%ROOT%\Customer 01\PN-01-02"
md "%ROOT%\Customer 01\PN-01-02\QC\Archive" 2>nul

rem 3  lowercase folder name - the match is case-insensitive, prove it
call :mkpart "%ROOT%\Customer 02\PN-02-lower"
md "%ROOT%\Customer 02\PN-02-lower\qc" 2>nul

rem 4  an ampersand in a customer name, which breaks a lot of path handling
call :mkpart "%ROOT%\Acme & Sons\PN-AMP-01"
md "%ROOT%\Acme & Sons\PN-AMP-01\QC" 2>nul

rem 5  an apostrophe, and a space, in the same path
call :mkpart "%ROOT%\O'Brien Tooling\PN-APO-01"
md "%ROOT%\O'Brien Tooling\PN-APO-01\QC" 2>nul

rem 6  the family shape - QC at depth 4
call :mkpart "%ROOT%\Customer 03\Turbine Family\PN-03-F01"
md "%ROOT%\Customer 03\Turbine Family\PN-03-F01\QC" 2>nul

rem 7  QC at depth 5. Should NOT be found at Search depth 4 - if it turns up,
rem    the depth limit is not working.
call :mkpart "%ROOT%\Customer 04\Deep Family\PN-04-D01\Old Revs"
md "%ROOT%\Customer 04\Deep Family\PN-04-D01\Old Revs\QC" 2>nul

rem 8  a part folder with a QC AND subfolders. Nothing below a part folder is
rem    indexed, so the walker must stop here rather than wander into Setups.
call :mkpart "%ROOT%\Customer 05\PN-05-01"
md "%ROOT%\Customer 05\PN-05-01\QC" 2>nul
md "%ROOT%\Customer 05\PN-05-01\Setups\Op10" 2>nul
md "%ROOT%\Customer 05\PN-05-01\Setups\Op20" 2>nul

rem 9  an empty customer, and a customer holding only loose files
md "%ROOT%\Customer 06 (empty)" 2>nul
md "%ROOT%\Customer 07 (files only)" 2>nul
type nul > "%ROOT%\Customer 07 (files only)\notes.txt"
type nul > "%ROOT%\Customer 07 (files only)\quote.pdf"

rem ---- summary --------------------------------------------------------------
for /f %%n in ('dir /s /b /ad "%ROOT%" 2^>nul ^| find /c /v ""') do set "NDIRS=%%n"
for /f %%n in ('dir /s /b /a-d "%ROOT%" 2^>nul ^| find /c /v ""') do set "NFILES=%%n"

echo.
echo ===========================================================================
echo   Built: %NDIRS% folders, %NFILES% files
echo.
echo   Share root to paste into Settings:
echo       %ROOT%
echo.
echo   Set Search depth to 4, then press Rebuild index.
echo   Expect: 0 packages, and the folder count to climb the whole way.
echo.
echo   Seven QC folders exist and are empty. Save a package into one and
echo   rebuild again - these should be found:
echo       Customer 01\PN-01-01\QC
echo       Customer 01\PN-01-02\QC              (and its Archive)
echo       Customer 02\PN-02-lower\qc           (lowercase)
echo       Acme ^& Sons\PN-AMP-01\QC
echo       O'Brien Tooling\PN-APO-01\QC
echo       Customer 03\Turbine Family\PN-03-F01\QC
echo       Customer 05\PN-05-01\QC              (has Setups beside it)
echo.
echo   This one is deeper than Search depth 4 and should NOT be found:
echo       Customer 04\Deep Family\PN-04-D01\Old Revs\QC
echo.
echo   Delete it all again with:  mockshare.bat clean
echo ===========================================================================
goto :done

rem ---------------------------------------------------------------------------
:mkpart
rem %1 = part folder. Gets the subfolders and the pile of loose files that a
rem real part folder carries - that pile is what the old crawl was probing.
md "%~1\CAM" 2>nul
md "%~1\Prints" 2>nul
for /L %%f in (1,1,%FILES%) do type nul > "%~1\job%%f.nc"
goto :eof

:done
endlocal
echo.
pause
