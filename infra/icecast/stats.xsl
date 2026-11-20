<?xml version="1.0" encoding="UTF-8"?>
<!-- Minimal, valid JSON stats (Icecast 2.4.4's bundled status-json.xsl emits broken JSON). -->
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
<xsl:output omit-xml-declaration="yes" method="text" encoding="UTF-8" media-type="application/json"/>
<xsl:strip-space elements="*"/>
<xsl:template match="/icestats">{"mounts":[<xsl:for-each select="source">{"mount":"<xsl:value-of select="@mount"/>","listeners":<xsl:choose><xsl:when test="string(number(listeners)) != 'NaN'"><xsl:value-of select="listeners"/></xsl:when><xsl:otherwise>0</xsl:otherwise></xsl:choose>}<xsl:if test="position() != last()">,</xsl:if></xsl:for-each>]}</xsl:template>
</xsl:stylesheet>
